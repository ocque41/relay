/**
 * Workspace guards for the dual-workspace model.
 *
 *   requireUserWorkspace   — rejects if the session is currently acting as a tenant.
 *   requireTenantWorkspace — rejects if the session is acting as a user, and
 *                            puts the active tenant_id onto the Hono context.
 *
 *   requireTenantWorkspaceFromBearerOrSession — same contract as
 *     requireTenantWorkspace, but also accepts an `Authorization: Bearer
 *     <agent_token>` header with `X-Relay-Tenant: <tenant_id>` (fallback query
 *     param `?tenant=<id>`). Lets AI agents call `/v1/dev/*` without first
 *     establishing a cookie session.
 *
 *   requireUserFromBearerOrSession — user-scope counterpart. Accepts either
 *     an agent bearer token (resolves to agent.user_id) or a valid session
 *     cookie. Used by `/v1/user/billing/*` so the CLI can hit balance +
 *     checkout endpoints without first establishing a cookie session.
 *
 * The first two assume sessionAuth has already populated `session` on the
 * context. If you compose them onto a route, chain them after sessionAuth. The
 * bearer-or-session pair does its own session check as a fallback and does
 * not require sessionAuth to be chained — each runs the full bearer path first.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index';
import { agents, tenant_members, tenants } from '../db/schema';
import { hashToken } from '../crypto';
import { readSession, type SessionEnv, type SessionUser } from './session';

export type WorkspaceEnv = SessionEnv & {
  Variables: SessionEnv['Variables'] & {
    activeTenantId?: string;
    /**
     * User id actively acting on the tenant. Set by
     * `requireTenantWorkspaceFromBearerOrSession` in both auth paths, and by
     * `requireTenantWorkspace` in the session path, so downstream handlers
     * can check tenant ownership without depending on `session` being present.
     */
    activeUserId?: string;
  };
};

function session(c: Context): SessionUser | null {
  return (c.get('session') as SessionUser | undefined) ?? null;
}

export const requireUserWorkspace: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const s = session(c);
  if (!s) return c.json({ error: 'unauthorized' }, 401);
  if (s.activeWorkspace.kind !== 'user') {
    return c.json({ error: 'workspace_mismatch', expected: 'user' }, 403);
  }
  await next();
};

export const requireTenantWorkspace: MiddlewareHandler<WorkspaceEnv> = async (c, next) => {
  const s = session(c);
  if (!s) return c.json({ error: 'unauthorized' }, 401);
  if (s.activeWorkspace.kind !== 'tenant') {
    return c.json({ error: 'workspace_mismatch', expected: 'tenant' }, 403);
  }
  c.set('activeTenantId', s.activeWorkspace.tenantId);
  c.set('activeUserId', s.userId);
  await next();
};

/**
 * Ask the DB whether `userId` is an owner or member of `tenantId`. Callers of
 * POST /v1/session/workspace use this to decide whether to allow the switch.
 */
export async function userCanAccessTenant(
  userId: string,
  tenantId: string,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(eq(tenants.id, tenantId), eq(tenants.owner_user_id, userId)))
    .limit(1);
  if (owned) return true;

  const [member] = await db
    .select({ tenant_id: tenant_members.tenant_id })
    .from(tenant_members)
    .where(
      and(
        eq(tenant_members.tenant_id, tenantId),
        eq(tenant_members.user_id, userId),
      ),
    )
    .limit(1);
  return Boolean(member);
}

/**
 * Accept either an agent bearer token OR a cookie session with an active
 * tenant workspace. Used by `/v1/dev/*` so AI agents can manage tenant
 * products (and other dev-workspace resources) without clicking through the
 * dashboard.
 *
 * Bearer path:
 *   1. SHA-256 the agent_token, look up a non-revoked row in `agents`.
 *   2. Resolve `agent.user_id` (error if null — a tokenless-user agent cannot
 *      impersonate a tenant).
 *   3. Read the requested tenant id from `X-Relay-Tenant` or `?tenant=`.
 *   4. Verify `userCanAccessTenant(user_id, tenantId)`.
 *   5. `c.set('activeTenantId', tenantId)` and continue.
 *
 * Session path:
 *   Falls through to `readSession` + the same invariants that
 *   `requireTenantWorkspace` enforces. Returns 401 if neither auth mode is
 *   present — this mirrors today's dashboard behaviour.
 */
export const requireTenantWorkspaceFromBearerOrSession: MiddlewareHandler<WorkspaceEnv> =
  async (c, next) => {
    const authorization = c.req.header('Authorization');
    const bearerToken =
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;

    if (bearerToken) {
      const tenantId =
        c.req.header('X-Relay-Tenant') ??
        c.req.query('tenant') ??
        null;
      if (!tenantId) {
        return c.json(
          {
            error:
              'missing tenant id — set X-Relay-Tenant header or ?tenant= query',
          },
          400,
        );
      }

      const hash = hashToken(bearerToken);
      const rows = await db
        .select({
          id: agents.id,
          user_id: agents.user_id,
          expires_at: agents.expires_at,
        })
        .from(agents)
        .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
        .limit(1);
      const agent = rows[0];
      if (!agent) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      if (agent.expires_at && agent.expires_at.getTime() <= Date.now()) {
        return c.json(
          {
            error: 'agent_token_expired',
            message:
              'Your Relay agent token has expired. Re-run register_tenant to get a new one.',
          },
          401,
        );
      }
      if (!agent.user_id) {
        // Legacy agent tokens minted before user ownership landed. They cannot
        // act on any tenant, so treat the bearer path as failed.
        return c.json(
          { error: 'agent token is not associated with a user' },
          403,
        );
      }

      const allowed = await userCanAccessTenant(agent.user_id, tenantId);
      if (!allowed) {
        return c.json(
          { error: 'forbidden: user is not a member of this tenant' },
          403,
        );
      }

      c.set('activeTenantId', tenantId);
      c.set('activeUserId', agent.user_id);
      await next();
      return;
    }

    // Session fallback — mirror sessionAuth + requireTenantWorkspace.
    const s = await readSession(c);
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    c.set('session', s);
    if (s.activeWorkspace.kind !== 'tenant') {
      return c.json({ error: 'workspace_mismatch', expected: 'tenant' }, 403);
    }
    c.set('activeTenantId', s.activeWorkspace.tenantId);
    c.set('activeUserId', s.userId);
    await next();
  };

/**
 * Accept either an agent bearer token OR a cookie session. Populates
 * `activeUserId` on the Hono context for downstream handlers. Used by the
 * user-scope billing routes so the CLI (bearer) and the dashboard (cookie)
 * share a single set of handlers.
 *
 * Bearer path:
 *   1. SHA-256 the token, look up a non-revoked row in `agents`.
 *   2. Require `agent.user_id` — legacy tokens without an owning user are
 *      rejected (nothing to charge, nothing to scope).
 *   3. `c.set('activeUserId', agent.user_id)` and continue.
 *
 * Session path:
 *   Falls through to `readSession`. Returns 401 if neither auth mode is
 *   present. When the session's active workspace is tenant-scoped we still
 *   accept it — user-scope billing is for the owning user's wallet, which is
 *   the same `session.userId` regardless of the active workspace facade.
 */
export const requireUserFromBearerOrSession: MiddlewareHandler<WorkspaceEnv> =
  async (c, next) => {
    const authorization = c.req.header('Authorization');
    const bearerToken =
      authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;

    if (bearerToken) {
      const hash = hashToken(bearerToken);
      const rows = await db
        .select({
          id: agents.id,
          user_id: agents.user_id,
          expires_at: agents.expires_at,
        })
        .from(agents)
        .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
        .limit(1);
      const agent = rows[0];
      if (!agent) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      if (agent.expires_at && agent.expires_at.getTime() <= Date.now()) {
        return c.json(
          {
            error: 'agent_token_expired',
            message:
              'Your Relay agent token has expired. Re-run register_tenant to get a new one.',
          },
          401,
        );
      }
      if (!agent.user_id) {
        return c.json(
          { error: 'agent token is not associated with a user' },
          403,
        );
      }
      c.set('activeUserId', agent.user_id);
      await next();
      return;
    }

    // Session fallback — mirror sessionAuth.
    const s = await readSession(c);
    if (!s) return c.json({ error: 'unauthorized' }, 401);
    c.set('session', s);
    c.set('activeUserId', s.userId);
    await next();
  };
