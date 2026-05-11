import { db } from './db/index';
import { audit_log } from './db/schema';

/**
 * Optional ownership scope attached to an audit entry. Populate when known —
 * developer dashboards filter by `tenant_id`, end-user dashboards by `user_id`.
 * Callers that don't know (e.g. pre-auth hooks) can omit both.
 */
export interface AuditScope {
  user_id?: string | null;
  tenant_id?: string | null;
}

/**
 * Record an audit-log entry. Never throws — a failed audit insert must never
 * take down the primary operation it's recording. Errors are logged to stderr.
 *
 * @param agentId    — uuid of the calling agent (from bearerAuth / MCP auth);
 *                     pass `null` for session-originated calls that have no
 *                     agent token (e.g. /v1/me/* dashboard actions).
 * @param action     — short machine-readable verb, e.g. 'signup_create'
 * @param target     — optional resource id the action targets
 * @param metadata   — optional free-form JSON context
 * @param scope      — optional ownership FKs (user_id / tenant_id)
 */
export async function recordAudit(
  agentId: string | null,
  action: string,
  target?: string | null,
  metadata?: Record<string, unknown>,
  scope?: AuditScope,
): Promise<void> {
  try {
    await db.insert(audit_log).values({
      agent_id: agentId,
      action,
      ...(target != null ? { target } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(scope?.user_id ? { user_id: scope.user_id } : {}),
      ...(scope?.tenant_id ? { tenant_id: scope.tenant_id } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[audit] failed to record action="${action}": ${msg}`);
  }
}
