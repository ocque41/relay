/**
 * Shared helper for resolving a calling agent's user_id.
 *
 * Bearer-auth middleware (src/server/auth.ts) puts `{ agentId, scopes }` on
 * the Hono context. Billable handlers that need to scope work to an end-user
 * also need the user id — that's what this helper returns.
 *
 * Returns `null` for legacy agent tokens minted before user ownership landed
 * on `agents.user_id`. Callers should treat that as an unauthorized state for
 * any billable action (we have nothing to charge).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { agents } from '../db/schema';

export async function callerUserId(agentId: string): Promise<string | null> {
  const [row] = await db
    .select({ user_id: agents.user_id })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return row?.user_id ?? null;
}
