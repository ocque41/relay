/**
 * Per-user monthly signup rate limit — the abuse prevention layer for the
 * integrator-only revenue model.
 *
 * End-users pay nothing, so a malicious or runaway agent could otherwise
 * burn through every integrator's quota. `checkUserSignupLimit(userId)`
 * enforces a hard per-month ceiling. The rollout sequence:
 *
 *   ABUSE_ENFORCEMENT=warn    — log breaches via pino + Sentry, don't 429
 *   ABUSE_ENFORCEMENT=enforce — throw UserRateLimited → HTTP 429
 *
 * The ceiling comes from `users.signup_limit_override` (admin raise) then
 * falls back to `USER_SIGNUP_MONTHLY_LIMIT` (env, default 50).
 *
 * Concurrency: single UPSERT with ON CONFLICT DO UPDATE … RETURNING count
 * gives us atomic read-modify-write. Two concurrent dispatches can't
 * race past the cap.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { user_action_counts, user_signup_counts, users } from '../db/schema';
import { logger } from '../logger';
import { Sentry } from '../sentry';

export class UserRateLimited extends Error {
  readonly status = 429 as const;
  override readonly name = 'UserRateLimited';
  constructor(
    public readonly userId: string,
    public readonly current: number,
    public readonly limit: number,
    public readonly periodYm: string,
    public readonly counter: 'signup' | 'action' = 'signup',
  ) {
    super(
      `user ${userId} exceeded monthly ${counter} cap: ${current}/${limit} in ${periodYm}`,
    );
  }
}

/** Reads `process.env.ABUSE_ENFORCEMENT`. Defaults to `warn` when unset. */
export function abuseMode(): 'off' | 'warn' | 'enforce' {
  const v = process.env.ABUSE_ENFORCEMENT;
  if (v === 'off') return 'off';
  if (v === 'enforce') return 'enforce';
  return 'warn';
}

function currentPeriodYm(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function defaultLimit(): number {
  const raw = process.env.USER_SIGNUP_MONTHLY_LIMIT;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 50;
  return Math.floor(parsed);
}

function defaultActionLimit(): number {
  const raw = process.env.USER_ACTION_MONTHLY_LIMIT;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 200;
  return Math.floor(parsed);
}

async function resolveLimitForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ override: users.signup_limit_override })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.override && row.override > 0) return row.override;
  return defaultLimit();
}

async function resolveActionLimitForUser(userId: string): Promise<number> {
  const [row] = await db
    .select({ override: users.action_limit_override })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.override && row.override > 0) return row.override;
  return defaultActionLimit();
}

/**
 * Atomically bump and check the user's signup counter for the current
 * calendar month. Returns the counter value post-increment for caller-side
 * logging. Throws `UserRateLimited` when `ABUSE_ENFORCEMENT=enforce` and
 * the post-increment value exceeds the user's cap. In `warn` mode the
 * breach is logged via pino + Sentry but the call still returns.
 *
 * No-op when `ABUSE_ENFORCEMENT=off`.
 */
export async function checkUserSignupLimit(userId: string): Promise<number | null> {
  const mode = abuseMode();
  if (mode === 'off') return null;

  const periodYm = currentPeriodYm();

  // UPSERT with RETURNING — single round trip, race-safe.
  const result = await db.execute(sql`
    INSERT INTO user_signup_counts (user_id, period_ym, count, updated_at)
    VALUES (${userId}, ${periodYm}, 1, now())
    ON CONFLICT (user_id, period_ym) DO UPDATE
      SET count = user_signup_counts.count + 1,
          updated_at = now()
    RETURNING count
  `);
  const row = (result as unknown as { rows?: Array<{ count: number | string }> }).rows?.[0];
  const current = row ? Number(row.count) : 1;

  const limit = await resolveLimitForUser(userId);

  if (current > limit) {
    logger.warn(
      { userId, currentCount: current, limit, periodYm, mode },
      'abuse.signup_limit_breached',
    );
    Sentry.captureMessage(
      `user_signup_limit_breached user=${userId} count=${current}/${limit}`,
      { level: 'warning' },
    );
    if (mode === 'enforce') {
      throw new UserRateLimited(userId, current, limit, periodYm);
    }
  }

  return current;
}

/**
 * Reverse a prior `checkUserSignupLimit` call. Called on workflow-start
 * failure so a user isn't billed against their cap for a signup that never
 * ran. Idempotent by construction — if the row was already at 0 we floor
 * at 0 rather than going negative.
 */
export async function decrementUserSignupLimit(userId: string): Promise<void> {
  if (abuseMode() === 'off') return;
  const periodYm = currentPeriodYm();
  await db.execute(sql`
    UPDATE user_signup_counts
       SET count = GREATEST(count - 1, 0),
           updated_at = now()
     WHERE user_id = ${userId}
       AND period_ym = ${periodYm}
  `);
}

/**
 * Per-user-month action cap. Mirror of `checkUserSignupLimit` for the
 * broader unit covering reveal/revoke/delete in addition to signups.
 *
 *   USER_ACTION_MONTHLY_LIMIT — env default (200)
 *   users.action_limit_override — per-user raise (NULL = use default)
 *   ABUSE_ENFORCEMENT — same three modes (off / warn / enforce)
 */
export async function checkUserActionLimit(userId: string): Promise<number | null> {
  const mode = abuseMode();
  if (mode === 'off') return null;

  const periodYm = currentPeriodYm();

  const result = await db.execute(sql`
    INSERT INTO user_action_counts (user_id, period_ym, count, updated_at)
    VALUES (${userId}, ${periodYm}, 1, now())
    ON CONFLICT (user_id, period_ym) DO UPDATE
      SET count = user_action_counts.count + 1,
          updated_at = now()
    RETURNING count
  `);
  const row = (result as unknown as { rows?: Array<{ count: number | string }> }).rows?.[0];
  const current = row ? Number(row.count) : 1;

  const limit = await resolveActionLimitForUser(userId);

  if (current > limit) {
    logger.warn(
      { userId, currentCount: current, limit, periodYm, mode, counter: 'action' },
      'abuse.action_limit_breached',
    );
    Sentry.captureMessage(
      `user_action_limit_breached user=${userId} count=${current}/${limit}`,
      { level: 'warning' },
    );
    if (mode === 'enforce') {
      throw new UserRateLimited(userId, current, limit, periodYm, 'action');
    }
  }

  return current;
}

/**
 * Reverse a prior `checkUserActionLimit` call. Called when the action
 * fails downstream so the user isn't billed against their cap.
 */
export async function decrementUserActionLimit(userId: string): Promise<void> {
  if (abuseMode() === 'off') return;
  const periodYm = currentPeriodYm();
  await db.execute(sql`
    UPDATE user_action_counts
       SET count = GREATEST(count - 1, 0),
           updated_at = now()
     WHERE user_id = ${userId}
       AND period_ym = ${periodYm}
  `);
}

// Reference imports kept so unused-vars doesn't fire on user_action_counts
// when the table is touched only via raw SQL above.
void user_action_counts;
