/**
 * /v1/integrator/auth/* — attestation endpoint the integrator flow hinges on.
 *
 * Agent A hits `POST /v1/integrator/auth/attest` with its own Relay bearer
 * token + a target `tenantSlug`. Relay returns a 5-minute RS256 JWT the
 * agent forwards to the integrator's backend. The integrator verifies via
 * Relay's JWKS, matches `aud` against its own tenantId, and issues its OWN
 * session cookie. Relay never sets cookies on integrator domains.
 *
 * Identity side-effect: if there's no `user_external_identities` row yet for
 * (Relay user, tenant), one is created with a fresh UUID as the stable
 * external_user_id. Re-calling is idempotent — the same external_user_id is
 * returned so integrators can key their local user rows on it safely.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import {
  requireTenantUserCapacity,
  UserCapExceeded,
} from '../billing/user-cap';
import { signAttestation } from '../auth/attest';
import { db } from '../db/index';
import { agents, tenants, user_external_identities, users } from '../db/schema';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<AppEnv>();
const ErrorResponse = z.object({ error: z.string() });

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/integrator/auth/attest',
    tags: ['integrator', 'auth'],
    summary: 'Exchange an agent bearer for an integrator attestation JWT',
    description:
      'Returns a short-lived (5 min) RS256 JWT pinned to a specific tenant. ' +
      'Integrators verify against /.well-known/jwks.json, match `aud` to ' +
      'their own tenantId, then issue their own session.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                tenantSlug: z.string().min(1).max(40).optional(),
                tenantId: z.string().uuid().optional(),
              })
              .refine((v) => v.tenantSlug || v.tenantId, {
                message: 'tenantSlug or tenantId required',
              }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Attestation JWT.',
        content: {
          'application/json': {
            schema: z.object({
              jwt: z.string(),
              externalUserId: z.string(),
              tenantId: z.string().uuid(),
              expiresAt: z.string().datetime(),
            }),
          },
        },
      },
      401: {
        description: 'Unauthorized.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      402: {
        description: 'Insufficient balance.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      403: {
        description: 'Agent has no owning user.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      404: {
        description: 'Tenant not found.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      429: {
        description: 'Tenant user cap reached.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              current: z.number(),
              limit: z.number(),
              upgrade_url: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const body = c.req.valid('json');

    // Agent must have an owning Relay user.
    const [agentRow] = await db
      .select({ user_id: agents.user_id })
      .from(agents)
      .where(eq(agents.id, agent.agentId))
      .limit(1);
    const relayUserId = agentRow?.user_id ?? null;
    if (!relayUserId) {
      return c.json({ error: 'agent has no owning user' }, 403);
    }

    // Resolve tenant by slug or id.
    const tenantRow = await (async () => {
      if (body.tenantId) {
        const [r] = await db
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.id, body.tenantId))
          .limit(1);
        return r;
      }
      const [r] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, body.tenantSlug!))
        .limit(1);
      return r;
    })();
    if (!tenantRow) return c.json({ error: 'tenant not found' }, 404);
    const tenantId = tenantRow.id;

    // Look up or create the (user, tenant) external-identity row. We check
    // this FIRST because returning users are exempt from the tenant user cap
    // and the free-action meter (they've already been counted).
    let externalUserId: string;
    let isNewIdentity = false;
    const [existing] = await db
      .select({ external_user_id: user_external_identities.external_user_id })
      .from(user_external_identities)
      .where(
        and(
          eq(user_external_identities.user_id, relayUserId),
          eq(user_external_identities.tenant_id, tenantId),
        ),
      )
      .limit(1);
    if (existing) {
      externalUserId = existing.external_user_id;
    } else {
      // New identity for this (user, tenant) pair. Enforce the user cap
      // (Pricing v2) BEFORE inserting. -1 cap = unlimited.
      try {
        await requireTenantUserCapacity(tenantId);
      } catch (err) {
        if (err instanceof UserCapExceeded) {
          return c.json(
            {
              error: 'tenant_user_cap_reached',
              current: err.current,
              limit: err.limit,
              upgrade_url: 'https://relay.cumulush.com/dev/billing',
            },
            429,
          );
        }
        throw err;
      }

      externalUserId = randomUUID();
      await db.insert(user_external_identities).values({
        user_id: relayUserId,
        tenant_id: tenantId,
        external_user_id: externalUserId,
      });
      isNewIdentity = true;
    }

    // Attestation is free under the integrator-only revenue model.
    void isNewIdentity;

    // Pull the user's email so integrators can pre-populate their own user
    // record on first attest.
    const [userRow] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, relayUserId))
      .limit(1);

    const { jwt, claims } = await signAttestation({
      tenantId,
      externalUserId,
      relayUserId,
      email: userRow?.email ?? null,
      actor: 'agent',
      agentId: agent.agentId,
    });

    await recordAudit(
      agent.agentId,
      'attest_agent',
      tenantId,
      { external_user_id: externalUserId },
      { user_id: relayUserId, tenant_id: tenantId },
    );

    return c.json(
      {
        jwt,
        externalUserId,
        tenantId,
        expiresAt: new Date(claims.exp * 1000).toISOString(),
      },
      200,
    );
  },
);

export default app;
