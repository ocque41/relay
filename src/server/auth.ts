import type { MiddlewareHandler } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/index';
import { agents } from './db/schema';
import { hashToken } from './crypto';

/** Shape of the agent context stored in Hono's variable map. */
export type AgentContext = {
  agentId: string;
  scopes: string[];
  /** Null for user-owned agents; set for integrator keys pinned to a tenant. */
  userId: string | null;
  tenantId: string | null;
  /**
   * Personal workspace this user-scoped agent is pinned to.
   * Set from `agents.user_workspace_id`; null for integrator-scoped agents
   * and for legacy user agents without a pin (downstream code falls back to
   * `resolveActiveUserWorkspace(userId)` in that case).
   */
  userWorkspaceId: string | null;
};

/** Hono environment type — import this in app.ts to type the app. */
export type AppEnv = {
  Variables: {
    agent: AgentContext;
  };
};

/**
 * Bearer-auth Hono middleware.
 *
 * 1. Extracts the token from `Authorization: Bearer <token>`.
 * 2. Hashes it with SHA-256.
 * 3. Looks up a non-revoked agent in the database.
 * 4. Returns 401 JSON if the token is absent or invalid.
 * 5. Stores `{ agentId, scopes }` in `c.var.agent` for downstream handlers.
 */
export const bearerAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header('Authorization');
  const token =
    authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;

  if (!token) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const hash = hashToken(token);

  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
    .limit(1);

  const agent = rows[0];
  if (!agent) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  // Migration 0022: reject tokens whose `expires_at` is in the past. A NULL
  // `expires_at` means "never expires" (opt-in, per mint-token.ts). Returning
  // a distinct error shape lets callers distinguish "rotate me" from
  // "unauthorized" — CLIs can re-run login without the user re-consenting.
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

  c.set('agent', {
    agentId: agent.id,
    scopes: (agent.scopes as string[]) ?? [],
    userId: agent.user_id,
    tenantId: agent.tenant_id,
    userWorkspaceId: agent.user_workspace_id,
  });

  await next();
};

/**
 * Integrator-key bearer-auth middleware. Used on `/v1/integrator/*` routes
 * that a tenant's own SERVER calls (not its agents). Requires an agent row
 * that:
 *   - Is not revoked (same as bearerAuth)
 *   - Carries `scopes` containing `'integrator'`
 *   - Has a non-null `tenant_id` (pinned to one integrator)
 *
 * Both conditions are required — an unpinned agent cannot be promoted to an
 * integrator key by scope alone. Resolution happens in a single DB read;
 * on success `c.var.agent` carries the same shape bearerAuth provides plus
 * a guaranteed-non-null `tenantId`.
 */
export const requireIntegratorKey: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authorization = c.req.header('Authorization');
  const token =
    authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  const hash = hashToken(token);
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.token_hash, hash), isNull(agents.revoked_at)))
    .limit(1);
  if (!agent) return c.json({ error: 'unauthorized' }, 401);

  if (agent.expires_at && agent.expires_at.getTime() <= Date.now()) {
    return c.json(
      {
        error: 'agent_token_expired',
        message:
          'Your Relay integrator key has expired. Mint a new one from the dashboard.',
      },
      401,
    );
  }

  const scopes = (agent.scopes as string[]) ?? [];
  if (!scopes.includes('integrator') || !agent.tenant_id) {
    return c.json({ error: 'integrator_scope_required' }, 403);
  }

  c.set('agent', {
    agentId: agent.id,
    scopes,
    userId: agent.user_id,
    tenantId: agent.tenant_id,
    userWorkspaceId: agent.user_workspace_id,
  });

  await next();
};
