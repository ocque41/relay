/**
 * Per-key per-day reveal cap — short-window abuse layer for the action
 * meter. Defends against a malicious end-user spamming reveal/rotate
 * loops to drain an integrator's monthly action quota.
 *
 * Single in-memory bucket keyed by `(userId, keyId)`. Window is one
 * UTC day (`YYYY-MM-DD`); rolling forward swaps in a fresh bucket.
 * Default cap from `USER_KEY_REVEAL_DAILY_LIMIT` (env, default 10).
 *
 * Like `rate-limit.ts`, this is per-instance, not global. Fluid Compute
 * concurrent-instance fan-out can let the true ceiling be (N × cap),
 * which is acceptable — the limiter exists to stop runaway loops, not
 * to enforce a precise daily quota.
 *
 * Modes mirror `ABUSE_ENFORCEMENT`: off → no-op, warn → log only,
 * enforce → throw UserRateLimited (counter='action').
 */
import { abuseMode, UserRateLimited } from './signup-limit';
import { logger } from '../logger';
import { Sentry } from '../sentry';

interface Bucket {
  count: number;
  day: string; // ISO YYYY-MM-DD UTC
}

const buckets = new Map<string, Bucket>();

function currentDay(): string {
  return new Date().toISOString().slice(0, 10);
}

function defaultLimit(): number {
  const raw = process.env.USER_KEY_REVEAL_DAILY_LIMIT;
  const parsed = raw === undefined ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 10;
  return Math.floor(parsed);
}

/** Opportunistic sweep so the Map can't grow unbounded. */
function sweep(): void {
  if (buckets.size < 2048) return;
  const today = currentDay();
  for (const [k, b] of buckets) {
    if (b.day !== today) buckets.delete(k);
  }
}

/**
 * Bump and check the daily reveal counter for `(userId, keyId)`. Returns
 * the post-increment count. Throws `UserRateLimited` in `enforce` mode
 * when the counter exceeds the cap. Logs + Sentry-warns in `warn` mode.
 * No-op when `ABUSE_ENFORCEMENT=off`.
 */
export function checkKeyRevealLimit(userId: string, keyId: string): number | null {
  const mode = abuseMode();
  if (mode === 'off') return null;

  sweep();
  const day = currentDay();
  const k = `${userId}:${keyId}`;
  const existing = buckets.get(k);
  const next = !existing || existing.day !== day ? 1 : existing.count + 1;
  buckets.set(k, { count: next, day });

  const limit = defaultLimit();
  if (next > limit) {
    logger.warn(
      { userId, keyId, currentCount: next, limit, day, mode, counter: 'reveal' },
      'abuse.key_reveal_limit_breached',
    );
    Sentry.captureMessage(
      `user_key_reveal_limit_breached user=${userId} key=${keyId} count=${next}/${limit}`,
      { level: 'warning' },
    );
    if (mode === 'enforce') {
      throw new UserRateLimited(userId, next, limit, day, 'action');
    }
  }
  return next;
}

/** Exposed for tests — reset all in-memory state. */
export function __resetKeyRevealLimitForTests(): void {
  buckets.clear();
}
