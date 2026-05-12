/**
 * /v1/tenants/:slugOrId/actions and /v1/actions/execute.
 *
 * Discovery: any agent bearer can list the public, non-disabled actions of a
 * tenant. The response is pure metadata — slug, display_name, description,
 * input/output schemas — so the agent can decide which one to invoke.
 *
 * Execute: the core loop.
 *   1. bearerAuth → c.var.agent
 *   2. resolve action by (tenantSlug, actionSlug)
 *   3. upsert user_external_identities (identity binding — prevents
 *      impersonation when the agent provides a foreign externalUserId)
 *   4. validate input against action.input_schema (Ajv). 400 before dispatch.
 *   5. check circuit breaker for this action (open → 502)
 *   6. idempotency lookup: if (tenant, action, external, key) matches an
 *      existing row, return the cached result (no re-dispatch)
 *   7. requireActiveTenantSubscription + requireActionsQuotaAvailable —
 *      integrator-side guard (only when BILLING_ENFORCEMENT != off)
 *   8. insert action_invocations row with status='dispatched'
 *   9. hmacPost to action.endpoint_url — 30s timeout
 *  10. success → status='succeeded' | 'overage', update latency/completed
 *  11. timeout → status='unknown', 504
 *  12. 4xx/5xx → status='failed', return 502
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { bearerAuth, requireIntegratorKey, type AppEnv } from '../auth';
import {
  ActionQuotaExceeded,
  TenantInactive,
  billingMode,
  requireActionsQuotaAvailable,
  requireActiveTenantSubscription,
} from '../billing/charge';
import { decrypt } from '../crypto';
import { db } from '../db/index';
import {
  action_invocations,
  actions,
  tenants,
  user_external_identities,
} from '../db/schema';
import { validateActionInput } from '../actions/validate';
import { recordOutcome, shouldBreak } from '../actions/breaker';
import { hmacPost } from '../providers/hmac';
import { recordAudit } from '../audit';

const app = new OpenAPIHono<AppEnv>();
const ErrorResponse = z.object({ error: z.string() });

const SLUG_PARAM = z.string().min(1).max(64);

const ActionDiscoveryItem = z.object({
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------------------
// GET /v1/tenants/:slugOrId/actions — discover public catalog
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/tenants/{slugOrId}/actions',
    tags: ['actions'],
    summary: 'List a tenant\'s public actions',
    description:
      'Discovery endpoint for agents. Returns only actions with visibility=public and no disabled_at. Any valid agent bearer may call this.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth] as const,
    request: {
      params: z.object({
        slugOrId: z.string().openapi({ param: { name: 'slugOrId', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Catalog.',
        content: {
          'application/json': {
            schema: z.object({
              tenantId: z.string().uuid(),
              tenantSlug: z.string(),
              actions: z.array(ActionDiscoveryItem),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Tenant not found.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const { slugOrId } = c.req.valid('param');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(slugOrId);
    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(isUuid ? eq(tenants.id, slugOrId) : eq(tenants.slug, slugOrId))
      .limit(1);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);

    const rows = await db
      .select({
        slug: actions.slug,
        display_name: actions.display_name,
        description: actions.description,
        input_schema: actions.input_schema,
        output_schema: actions.output_schema,
      })
      .from(actions)
      .where(
        and(
          eq(actions.tenant_id, tenant.id),
          eq(actions.visibility, 'public'),
          isNull(actions.disabled_at),
        ),
      );

    return c.json(
      {
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        actions: rows.map((r) => ({
          slug: r.slug,
          display_name: r.display_name,
          description: r.description,
          input_schema: (r.input_schema as Record<string, unknown>) ?? {},
          output_schema: (r.output_schema as Record<string, unknown>) ?? {},
        })),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// POST /v1/actions/execute
// ---------------------------------------------------------------------------
const ExecuteBody = z.object({
  tenantSlug: z.string().min(1).max(40).optional(),
  tenantId: z.string().uuid().optional(),
  actionSlug: z.string().min(1).max(64),
  externalUserId: z.string().min(1).max(128).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
}).refine((v) => v.tenantSlug || v.tenantId, {
  message: 'tenantSlug or tenantId required',
});

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/actions/execute',
    tags: ['actions'],
    summary: 'Invoke an action on an integrator',
    description:
      'Dispatches an HMAC-signed call to the integrator\'s registered endpoint. Charges 1 token against the caller\'s wallet (price: action_execute). Counts against the tenant\'s monthly quota. Supports Idempotency-Key header (24h window).',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth] as const,
    request: {
      headers: z.object({
        'idempotency-key': z.string().min(8).max(128).optional(),
      }),
      body: {
        required: true,
        content: { 'application/json': { schema: ExecuteBody } },
      },
    },
    responses: {
      200: {
        description: 'Action executed.',
        content: {
          'application/json': {
            schema: z.object({
              invocationId: z.string().uuid(),
              status: z.enum(['succeeded', 'overage']),
              latencyMs: z.number(),
              output: z.unknown(),
            }),
          },
        },
      },
      400: {
        description: 'Bad input (schema violation or malformed body).',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              violations: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
            }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      402: { description: 'Insufficient balance.', content: { 'application/json': { schema: ErrorResponse } } },
      403: { description: 'Identity not bound to this tenant.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Tenant or action not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: {
        description: 'Tenant monthly action quota exceeded.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              current: z.number(),
              included: z.number(),
              upgrade_url: z.string(),
            }),
          },
        },
      },
      502: { description: 'Integrator returned an error or is degraded.', content: { 'application/json': { schema: ErrorResponse } } },
      503: { description: 'Tenant subscription inactive.', content: { 'application/json': { schema: ErrorResponse } } },
      504: {
        description: 'Integrator timed out — invocation status unknown.',
        content: {
          'application/json': {
            schema: z.object({
              error: z.string(),
              invocationId: z.string().uuid(),
              reconcileHint: z.string(),
            }),
          },
        },
      },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const body = c.req.valid('json');
    const idempotencyKey = c.req.header('Idempotency-Key') ?? c.req.header('idempotency-key') ?? null;

    // Agent needs an owning user — integrator keys are not allowed to execute
    // on behalf of themselves; the user wallet and identity binding are scoped
    // to human users.
    if (!agent.userId) {
      return c.json({ error: 'agent_has_no_user' }, 403);
    }

    // 1. Resolve tenant
    const [tenant] = await db
      .select({ id: tenants.id, slug: tenants.slug })
      .from(tenants)
      .where(body.tenantId ? eq(tenants.id, body.tenantId) : eq(tenants.slug, body.tenantSlug!))
      .limit(1);
    if (!tenant) return c.json({ error: 'tenant_not_found' }, 404);

    // 2. Resolve action
    const [action] = await db
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.tenant_id, tenant.id),
          eq(actions.slug, body.actionSlug),
          isNull(actions.disabled_at),
        ),
      )
      .limit(1);
    if (!action) return c.json({ error: 'action_not_found' }, 404);
    if (action.visibility === 'private') {
      // Private-action allowlist enforcement is deferred; fail closed.
      return c.json({ error: 'action_private' }, 403);
    }

    // 3. Identity binding. If the caller supplied an externalUserId, verify
    //    it matches the (agentUser, tenant) row. If absent, upsert one so the
    //    invocation always carries a stable integrator-side identity.
    let externalUserId: string;
    const [existingIdent] = await db
      .select({ external_user_id: user_external_identities.external_user_id })
      .from(user_external_identities)
      .where(
        and(
          eq(user_external_identities.user_id, agent.userId),
          eq(user_external_identities.tenant_id, tenant.id),
        ),
      )
      .limit(1);

    if (body.externalUserId) {
      if (!existingIdent) {
        return c.json({ error: 'identity_not_bound' }, 403);
      }
      if (existingIdent.external_user_id !== body.externalUserId) {
        return c.json({ error: 'identity_mismatch' }, 403);
      }
      externalUserId = existingIdent.external_user_id;
    } else if (existingIdent) {
      externalUserId = existingIdent.external_user_id;
    } else {
      externalUserId = randomUUID();
      await db.insert(user_external_identities).values({
        user_id: agent.userId,
        tenant_id: tenant.id,
        external_user_id: externalUserId,
      });
    }

    // 4. Validate input against JSON Schema (Ajv). Bad input = 400, no charge.
    const validation = validateActionInput(action.id, action.input_schema, body.input);
    if (!validation.ok) {
      return c.json(
        { error: 'input_invalid', violations: validation.errors ?? [] },
        400,
      );
    }

    // 5. Circuit breaker
    if (shouldBreak(action.id)) {
      return c.json({ error: 'integrator_degraded' }, 502);
    }

    // 6. Idempotency replay
    if (idempotencyKey) {
      const [cached] = await db
        .select()
        .from(action_invocations)
        .where(
          and(
            eq(action_invocations.tenant_id, tenant.id),
            eq(action_invocations.action_id, action.id),
            eq(action_invocations.external_user_id, externalUserId),
            eq(action_invocations.idempotency_key, idempotencyKey),
          ),
        )
        .limit(1);
      if (cached) {
        const ageHours = cached.created_at
          ? (Date.now() - new Date(cached.created_at).getTime()) / 36e5
          : 0;
        if (ageHours < 24) {
          if (cached.status === 'succeeded' || cached.status === 'overage') {
            return c.json(
              {
                invocationId: cached.id,
                status: cached.status as 'succeeded' | 'overage',
                latencyMs: cached.latency_ms ?? 0,
                output: { idempotent_replay: true },
              },
              200,
            );
          }
          if (cached.status === 'failed') {
            return c.json({ error: cached.error ?? 'integrator_error' }, 502);
          }
          if (cached.status === 'unknown') {
            return c.json(
              {
                error: 'integrator_timeout',
                invocationId: cached.id,
                reconcileHint: 'POST /v1/actions/invocations/:id/reconcile',
              },
              504,
            );
          }
        }
      }
    }

    // 7. Tenant subscription gate + quota claim (atomic).
    //    When BILLING_ENFORCEMENT=off we mirror the tenant.ts gate behavior:
    //    no subscription requirement, no quota claim. Keeps dev + tests usable
    //    without a full Stripe state machine populated. In warn / enforce mode
    //    both checks are fully live.
    const mode = billingMode();
    let quota: { used: number; included: number; overage: boolean };
    if (mode === 'off') {
      quota = { used: 0, included: -1, overage: false };
    } else {
      try {
        await requireActiveTenantSubscription(tenant.id);
      } catch (err) {
        if (err instanceof TenantInactive) {
          return c.json({ error: `tenant_${err.state}` }, 503);
        }
        throw err;
      }

      try {
        quota = await requireActionsQuotaAvailable(tenant.id);
      } catch (err) {
        if (err instanceof ActionQuotaExceeded) {
          await db.insert(action_invocations).values({
            action_id: action.id,
            tenant_id: tenant.id,
            user_id: agent.userId,
            agent_id: agent.agentId,
            external_user_id: externalUserId,
            idempotency_key: idempotencyKey,
            status: 'quota_denied',
          });
          return c.json(
            {
              error: 'tenant_action_quota_exceeded',
              current: err.current,
              included: err.included,
              upgrade_url: 'https://relay.cumulush.com/dev/billing',
            },
            429,
          );
        }
        throw err;
      }
    }

    // 8. Insert invocation row (status='dispatched'). End-user execution is
    //    free; integrator quota was checked above.
    const [invocation] = await db
      .insert(action_invocations)
      .values({
        action_id: action.id,
        tenant_id: tenant.id,
        user_id: agent.userId,
        agent_id: agent.agentId,
        external_user_id: externalUserId,
        idempotency_key: idempotencyKey,
        status: 'dispatched',
      })
      .returning({ id: action_invocations.id });

    // 10. HMAC dispatch
    const secret = decrypt(action.webhook_secret_enc).toString('utf8');
    const requestId = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const result = await hmacPost({
      url: action.endpoint_url,
      method: action.endpoint_method,
      secret,
      body: {
        requestId,
        actionSlug: action.slug,
        externalUserId,
        relayUserId: agent.userId,
        input: body.input,
        nonce,
        ts: Math.floor(Date.now() / 1000),
      },
      headers: {
        'X-Relay-Action': action.slug,
        'X-Relay-Request-Id': requestId,
      },
      timeoutMs: action.timeout_ms,
      label: `action:${action.slug}`,
    });

    // 11–13. Resolve status
    if (result.ok) {
      const finalStatus: 'succeeded' | 'overage' = quota.overage ? 'overage' : 'succeeded';
      await db
        .update(action_invocations)
        .set({
          status: finalStatus,
          latency_ms: result.latencyMs,
          completed_at: new Date(),
        })
        .where(eq(action_invocations.id, invocation.id));
      recordOutcome(action.id, true);
      await recordAudit(
        agent.agentId,
        'action_execute',
        invocation.id,
        { action_slug: action.slug, status: finalStatus, latency_ms: result.latencyMs },
        { tenant_id: tenant.id, user_id: agent.userId },
      );
      return c.json(
        {
          invocationId: invocation.id,
          status: finalStatus,
          latencyMs: result.latencyMs,
          output: result.data,
        },
        200,
      );
    }

    if (result.failure === 'timeout') {
      await db
        .update(action_invocations)
        .set({
          status: 'unknown',
          latency_ms: result.latencyMs,
          error: result.error,
          completed_at: new Date(),
        })
        .where(eq(action_invocations.id, invocation.id));
      recordOutcome(action.id, false);
      // NOT refunding on 'unknown' — the integrator may have executed. Keep
      // the charge until a reconciliation call confirms the outcome.
      return c.json(
        {
          error: 'integrator_timeout',
          invocationId: invocation.id,
          reconcileHint: 'POST /v1/actions/invocations/:id/reconcile',
        },
        504,
      );
    }

    // 4xx / 5xx / non_json / network -> 'failed'.
    await db
      .update(action_invocations)
      .set({
        status: 'failed',
        latency_ms: result.latencyMs,
        error: result.error,
        completed_at: new Date(),
      })
      .where(eq(action_invocations.id, invocation.id));
    recordOutcome(action.id, false);
    return c.json({ error: result.error || 'integrator_error' }, 502);
  },
);

// ---------------------------------------------------------------------------
// POST /v1/actions/invocations/:id/reconcile — integrator flips an unknown
// to succeeded/failed after confirming the internal outcome.
// ---------------------------------------------------------------------------

app.openapi(
  createRoute({
    method: 'post',
    path: '/v1/actions/invocations/{id}/reconcile',
    tags: ['actions'],
    summary: 'Reconcile an unknown-status invocation',
    security: [{ bearerAuth: [] }],
    middleware: [requireIntegratorKey] as const,
    request: {
      params: z.object({ id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }) }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              outcome: z.enum(['succeeded', 'failed']),
              note: z.string().max(500).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Reconciled.',
        content: {
          'application/json': {
            schema: z.object({ id: z.string().uuid(), status: z.string() }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found or not reconcilable.', content: { 'application/json': { schema: ErrorResponse } } },
    },
  }),
  async (c) => {
    const agent = c.get('agent');
    const { id } = c.req.valid('param');
    const { outcome, note } = c.req.valid('json');

    const [inv] = await db
      .select()
      .from(action_invocations)
      .where(
        and(
          eq(action_invocations.id, id),
          eq(action_invocations.tenant_id, agent.tenantId!),
          eq(action_invocations.status, 'unknown'),
        ),
      )
      .limit(1);
    if (!inv) return c.json({ error: 'not_found_or_not_unknown' }, 404);

    await db
      .update(action_invocations)
      .set({
        status: outcome,
        error: note ?? inv.error,
        completed_at: new Date(),
      })
      .where(eq(action_invocations.id, id));

    await recordAudit(
      agent.agentId,
      'action_reconcile',
      id,
      { outcome, note },
      { tenant_id: agent.tenantId!, ...(inv.user_id ? { user_id: inv.user_id } : {}) },
    );

    return c.json({ id, status: outcome }, 200);
  },
);

export default app;
