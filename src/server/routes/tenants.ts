/**
 * /v1/tenants — agent-driven self-serve tenant creation.
 *
 * Flow 1 from the drop-in plan: an agent with a Relay bearer token can
 * register a brand-new integrator as a tenant without a human sitting in
 * front of a dashboard. The agent receives:
 *   1. A `tenantId` + stable `slug`
 *   2. An integrator-scoped agent bearer (scope=['integrator'], tenant_id
 *      pinned) — this is the key the integrator's SERVER will use to call
 *      /v1/integrator/* routes later.
 *
 * Abuse gate: every call charges `tenant_create` (100 tokens). Free-tier
 * users get ~10 free tenants/month; paid users spill into balance.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { DEFAULT_AGENT_TOKEN_DAYS, mintAgentToken } from '../auth/mint-token';
import { db } from '../db/index';
import { agents, tenants } from '../db/schema';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<AppEnv>();
const ErrorResponse = z.object({ error: z.string() });

function slugify(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
  return base || 'tenant';
}

/** Hostname-ish validation. Accepts apex + subdomains; rejects scheme + path. */
const domainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, {
    message: 'domain must be a hostname (no scheme or path)',
  });

const originSchema = z
  .string()
  .url()
  .max(256)
  .refine((u) => {
    try {
      const p = new URL(u);
      return (
        (p.protocol === 'https:' || p.protocol === 'http:') &&
        !p.pathname.replace(/\/+$/, '')
      );
    } catch {
      return false;
    }
  }, 'origin must be a bare scheme+host (no path)');

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/tenants',
    tags: ['tenants'],
    summary: 'Register an integrator as a Relay tenant (agent-driven)',
    description:
      'Creates a tenant row owned by the calling agent\'s user and mints an ' +
      'integrator-scoped bearer token pinned to it. Plaintext integrator key ' +
      'is returned ONCE — store it in the integrator\'s environment.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth] as const,
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              name: z.string().min(1).max(120),
              slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(40).optional(),
              domain: domainSchema.optional(),
              rp_id: z.string().min(3).max(253).optional(),
              allowed_origins: z.array(originSchema).max(10).optional(),
              expires_in_days: z.number().int().min(1).max(365).optional(),
              never_expires: z.boolean().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: {
        description: 'Tenant + integrator key.',
        content: {
          'application/json': {
            schema: z.object({
              tenantId: z.string().uuid(),
              slug: z.string(),
              name: z.string(),
              domain: z.string().nullable(),
              rp_id: z.string().nullable(),
              allowed_origins: z.array(z.string()),
              integratorKey: z
                .string()
                .describe('Plaintext integrator bearer — shown once.'),
              integratorKeyId: z.string().uuid(),
              integratorKeyExpiresAt: z
                .string()
                .nullable()
                .describe(
                  'ISO-8601 instant when this integrator key expires. Null means never expires.',
                ),
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
        description: 'Agent has no owning user (cannot own tenants).',
        content: { 'application/json': { schema: ErrorResponse } },
      },
      409: {
        description: 'Slug or domain already taken.',
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const body = c.req.valid('json');

    // Agent must have an owning user — scopes like 'system' without user_id
    // cannot own tenants.
    const [ownerRow] = await db
      .select({ user_id: agents.user_id })
      .from(agents)
      .where(eq(agents.id, agent.agentId))
      .limit(1);
    const ownerUserId = ownerRow?.user_id ?? null;
    if (!ownerUserId) {
      return c.json({ error: 'agent has no owning user' }, 403);
    }

    // Tenant creation is free under the integrator-only revenue model.
    // Slug uniqueness. Append a random suffix if a clash is found AND the
    // caller did not pin an explicit slug (matches /v1/me/tenants behavior).
    const baseSlug = body.slug ?? slugify(body.name);
    let slug = baseSlug;
    const slugClash = await db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, baseSlug))
      .limit(1);
    if (slugClash[0]) {
      if (body.slug) {
        return c.json({ error: 'slug already taken' }, 409);
      }
      slug = `${baseSlug}-${randomBytes(2).toString('hex')}`;
    }

    // Domain uniqueness — enforced by the DB constraint too, but we want a
    // clean 409 rather than a generic 500.
    if (body.domain) {
      const domainClash = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.domain, body.domain))
        .limit(1);
      if (domainClash[0]) {
        return c.json({ error: 'domain already taken' }, 409);
      }
    }

    const [tenant] = await db
      .insert(tenants)
      .values({
        owner_user_id: ownerUserId,
        name: body.name,
        slug,
        domain: body.domain ?? null,
        rp_id: body.rp_id ?? body.domain ?? null,
        allowed_origins: body.allowed_origins ?? [],
      })
      .returning();

    const integratorMint = await mintAgentToken({
      userId: ownerUserId,
      tenantId: tenant.id,
      label: `${body.name} — server key`,
      scopes: ['integrator'],
      expiry: body.never_expires
        ? 'never'
        : { days: body.expires_in_days ?? DEFAULT_AGENT_TOKEN_DAYS },
      userRequestedNever: body.never_expires === true,
    });

    await recordAudit(
      agent.agentId,
      'tenant_create',
      tenant.id,
      {
        tenant_slug: tenant.slug,
        domain: tenant.domain,
        integrator_agent_id: integratorMint.agentId,
        integrator_key_expires_at: integratorMint.expiresAt
          ? integratorMint.expiresAt.toISOString()
          : null,
      },
      { user_id: ownerUserId, tenant_id: tenant.id },
    );

    return c.json(
      {
        tenantId: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        domain: tenant.domain,
        rp_id: tenant.rp_id,
        allowed_origins: (tenant.allowed_origins as string[]) ?? [],
        integratorKey: integratorMint.token,
        integratorKeyId: integratorMint.agentId,
        integratorKeyExpiresAt: integratorMint.expiresAt
          ? integratorMint.expiresAt.toISOString()
          : null,
      },
      201,
    );
  },
);

export default app;
