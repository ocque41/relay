import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { bearerAuth, type AppEnv } from '../auth';
import { readRateLimit, writeRateLimit } from '../rate-limit';
import { recordAudit } from '../audit';
import { db } from '../db/index';
import {
  accounts,
  agents,
  api_keys,
  audit_log,
  signup_jobs,
} from '../db/schema';
import { getProvider } from '../providers/index';
import type { NeonAccount } from '../providers/neon';
import { resolveActiveUserWorkspace } from '../user-workspaces';
import {
  chargeAction,
  refundAction,
  type ChargeReceipt,
} from '../billing/charge-action';
import { TenantInactive } from '../billing/charge';
import { IntegratorQuotaExhausted } from '../billing/quota';
import { UserRateLimited } from '../abuse/signup-limit';

/**
 * Resolve the user_id + pinned user_workspace_id for the calling agent.
 * Used to scope every accounts read/write so one user's agents cannot
 * observe another user's accounts *and* one workspace's agents cannot see
 * another workspace's accounts.
 *
 * For agents with a non-null `user_workspace_id`
 * user-scoped agent), we trust the pin. Legacy user-agents without a pin
 * fall back to the user's currently-active workspace.
 */
async function callerScope(
  agentId: string,
): Promise<{ userId: string; workspaceId: string } | null> {
  const [row] = await db
    .select({
      user_id: agents.user_id,
      user_workspace_id: agents.user_workspace_id,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!row?.user_id) return null;
  const workspaceId =
    row.user_workspace_id ??
    (await resolveActiveUserWorkspace(row.user_id)).id;
  return { userId: row.user_id, workspaceId };
}

const app = new OpenAPIHono<AppEnv>();

/** Columns we always select — never return credentials_enc. */
const safeColumns = {
  id: accounts.id,
  provider_id: accounts.provider_id,
  external_id: accounts.external_id,
  label: accounts.label,
  email_alias: accounts.email_alias,
  status: accounts.status,
  created_at: accounts.created_at,
} as const;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const Account = z
  .object({
    id: z.string().uuid(),
    provider_id: z.string(),
    external_id: z.string(),
    label: z.string(),
    email_alias: z.string().nullable(),
    status: z.string(),
    created_at: z.string().nullable().openapi({ description: 'ISO-8601 timestamp.' }),
  })
  .openapi('Account');

const AccountList = z.array(Account).openapi('AccountList');
const ErrorResponse = z.object({ error: z.string() });
const RateLimitResponse = z.object({
  error: z.string(),
  retryAfter: z.number().optional(),
});

const AuditEntry = z
  .object({
    id: z.string().uuid(),
    agent_id: z.string().uuid().nullable(),
    action: z.string(),
    target: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    created_at: z.string().nullable(),
  })
  .openapi('AuditEntry');

const AuditLogResponse = z
  .object({
    entries: z.array(AuditEntry),
    total: z.number(),
  })
  .openapi('AuditLogResponse');

// ---------------------------------------------------------------------------
// GET /v1/accounts
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/accounts',
    tags: ['accounts'],
    summary: 'List accounts',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, readRateLimit] as const,
    responses: {
      200: {
        description: 'All accounts (credentials omitted).',
        content: { 'application/json': { schema: AccountList } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    const agentId = c.get('agent').agentId;
    const scope = await callerScope(agentId);
    if (!scope) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const rows = await db
      .select(safeColumns)
      .from(accounts)
      .where(
        and(
          eq(accounts.user_id, scope.userId),
          eq(accounts.user_workspace_id, scope.workspaceId),
        ),
      );
    const mapped = rows.map((r) => ({
      ...r,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
    }));
    return c.json(mapped, 200);
  },
);

// ---------------------------------------------------------------------------
// GET /v1/audit-log    (admin)
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/audit-log',
    tags: ['audit'],
    summary: 'List audit-log entries',
    description:
      "Non-admin agents see only audit rows scoped to their own user. Agents with the 'admin' scope see platform-wide audit rows.",
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, readRateLimit] as const,
    request: {
      query: z.object({
        limit: z
          .string()
          .optional()
          .openapi({ description: 'Max rows to return (1-200).', example: '50' }),
        offset: z
          .string()
          .optional()
          .openapi({ description: 'Pagination offset.', example: '0' }),
      }),
    },
    responses: {
      200: {
        description: 'Paginated audit-log entries.',
        content: { 'application/json': { schema: AuditLogResponse } },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      403: { description: 'Forbidden.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    // Platform admin = explicit 'admin' scope. The legacy `*` scope is no
    // longer treated as admin — it's a user-level "all-endpoints" grant but
    // stays confined to that user's own data. True admin access requires
    // a token minted specifically with the 'admin' scope.
    const scopes = c.get('agent').scopes;
    const isAdmin = scopes.includes('admin');
    const scope = await callerScope(c.get('agent').agentId);

    const { limit: limitRaw, offset: offsetRaw } = c.req.valid('query');
    const limit = Math.min(200, Math.max(1, parseInt(limitRaw ?? '50', 10) || 50));
    const offset = Math.max(0, parseInt(offsetRaw ?? '0', 10) || 0);

    // Platform admin sees everything; non-admin agents see only audit rows
    // scoped to their own user+workspace. Nullable user_workspace_id on
    // audit_log rows (legacy + cross-workspace entries) are included so
    // historical records stay visible.
    const userAudit = scope
      ? and(
          eq(audit_log.user_id, scope.userId),
          sql`(${audit_log.user_workspace_id} IS NULL OR ${audit_log.user_workspace_id} = ${scope.workspaceId})`,
        )
      : null;
    const entriesQ = db.select().from(audit_log);
    const entries = await (isAdmin
      ? entriesQ.orderBy(desc(audit_log.created_at)).limit(limit).offset(offset)
      : userAudit
        ? entriesQ
            .where(userAudit)
            .orderBy(desc(audit_log.created_at))
            .limit(limit)
            .offset(offset)
        : Promise.resolve([]));

    const countQ = db.select({ count: sql<number>`count(*)::int` }).from(audit_log);
    const countRows = await (isAdmin
      ? countQ
      : userAudit
        ? countQ.where(userAudit)
        : Promise.resolve([{ count: 0 }]));
    const count = countRows[0]?.count ?? 0;

    return c.json(
      {
        entries: entries.map((e) => ({
          id: e.id,
          agent_id: e.agent_id,
          action: e.action,
          target: e.target,
          metadata: (e.metadata ?? null) as Record<string, unknown> | null,
          created_at: e.created_at ? new Date(e.created_at).toISOString() : null,
        })),
        total: Number(count ?? 0),
      },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// GET /v1/accounts/:id
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'get',
    path: '/v1/accounts/{id}',
    tags: ['accounts'],
    summary: 'Get an account',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, readRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: { description: 'The account.', content: { 'application/json': { schema: Account } } },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded.', content: { 'application/json': { schema: RateLimitResponse } } },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const scope = await callerScope(c.get('agent').agentId);
    if (!scope) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const rows = await db
      .select(safeColumns)
      .from(accounts)
      .where(
        and(
          eq(accounts.id, id),
          eq(accounts.user_id, scope.userId),
          eq(accounts.user_workspace_id, scope.workspaceId),
        ),
      )
      .limit(1);

    if (rows.length === 0) return c.json({ error: 'account not found' }, 404);
    const r = rows[0];
    return c.json(
      { ...r, created_at: r.created_at ? new Date(r.created_at).toISOString() : null },
      200,
    );
  },
);

// ---------------------------------------------------------------------------
// DELETE /v1/accounts/:id
// ---------------------------------------------------------------------------
app.openapi(
  createRoute({
    method: 'delete',
    path: '/v1/accounts/{id}',
    tags: ['accounts'],
    summary: 'Delete an account',
    description:
      'Calls the provider teardown if supported, removes child rows, deletes the account, and writes an audit-log entry.',
    security: [{ bearerAuth: [] }],
    middleware: [bearerAuth, writeRateLimit] as const,
    request: {
      params: z.object({
        id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
      }),
    },
    responses: {
      200: {
        description: 'Account deleted.',
        content: {
          'application/json': {
            schema: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
          },
        },
      },
      401: { description: 'Unauthorized.', content: { 'application/json': { schema: ErrorResponse } } },
      404: { description: 'Not found.', content: { 'application/json': { schema: ErrorResponse } } },
      429: { description: 'Rate limit exceeded or quota exhausted.', content: { 'application/json': { schema: RateLimitResponse } } },
      503: {
        description: "Integrator's Relay subscription is inactive; their product is temporarily unavailable.",
        content: { 'application/json': { schema: ErrorResponse } },
      },
    },
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const agentId = c.get('agent').agentId;
    const scope = await callerScope(agentId);
    if (!scope) return c.json({ error: 'agent_token is not associated with a user' }, 401);

    const rows = await db
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.id, id),
          eq(accounts.user_id, scope.userId),
          eq(accounts.user_workspace_id, scope.workspaceId),
        ),
      )
      .limit(1);

    if (rows.length === 0) return c.json({ error: 'account not found' }, 404);
    const account = rows[0];

    // Charge the delete action. Refunded if the cleanup throws.
    let receipt: ChargeReceipt;
    try {
      receipt = await chargeAction({
        tenantId: account.tenant_id,
        userId: scope.userId,
        providerId: account.provider_id,
        action: 'delete',
      });
    } catch (err) {
      if (err instanceof TenantInactive) {
        return c.json({ error: `tenant_${err.state}` }, 503);
      }
      if (err instanceof UserRateLimited || err instanceof IntegratorQuotaExhausted) {
        return c.json({ error: 'rate_limit_exceeded' }, 429);
      }
      throw err;
    }

    try {
      const provider = await getProvider(account.provider_id);
      if (provider?.teardown) {
        try {
          // Built-in providers (neon/vercel/resend) expect a NeonAccount-like shape;
          // tenant providers expect { accountId }. The fields we pass below cover both.
          const providerAccount = {
            projectId: account.external_id,
            accountId: account.external_id,
            name: account.label,
            connectionUri: '',
          };
          await provider.teardown({ db }, providerAccount as never);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[accounts] teardown failed for ${id}:`, msg);
        }
      }

      await db.delete(api_keys).where(eq(api_keys.account_id, id));
      await db
        .update(signup_jobs)
        .set({ account_id: null })
        .where(eq(signup_jobs.account_id, id));
      await db.delete(accounts).where(eq(accounts.id, id));
    } catch (err) {
      await refundAction({
        tenantId: account.tenant_id,
        userId: scope.userId,
        receipt,
      });
      throw err;
    }

    // Audit: record account deletion AFTER the delete succeeds.
    await recordAudit(
      agentId,
      'account_delete',
      id,
      { provider_id: account.provider_id },
      { user_id: account.user_id, tenant_id: account.tenant_id },
    );

    return c.json({ deleted: true as const, id }, 200);
  },
);

export default app;
