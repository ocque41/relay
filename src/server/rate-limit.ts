import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './auth';

/**
 * Simple fixed-window in-memory rate limiter, keyed by agent id.
 *
 * Fluid Compute reuses function instances across concurrent requests, so this
 * catches bursts within the same instance. Across parallel instances the true
 * ceiling can be (N instances × limit) — that's acceptable; the limiter exists
 * to stop runaway loops, not to enforce a hard global quota.
 *
 * Window: 60 seconds. Counters reset after the window expires.
 */
interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const buckets = new Map<string, Bucket>();

// Housekeeping: opportunistically drop expired buckets so the Map doesn't
// grow without bound in a long-lived instance.
function sweep(now: number): void {
  if (buckets.size < 1024) return;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

function hit(key: string, limit: number): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  sweep(now);
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return { ok: true };
  }
  if (existing.count >= limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
  }
  existing.count += 1;
  return { ok: true };
}

/**
 * Build a Hono middleware enforcing `limit` requests per 60s per agent id.
 * Must be mounted AFTER bearerAuth — it reads `c.var.agent.agentId`.
 *
 * Responds 429 JSON `{ error, retryAfter }` with `Retry-After` header.
 */
export function rateLimit(limit: number): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const agent = c.get('agent');
    // If somehow called without an auth context, fall back to a per-IP key so
    // the limiter never silently becomes a no-op.
    const key = agent?.agentId
      ? `agent:${agent.agentId}:${limit}`
      : `ip:${c.req.header('x-forwarded-for') ?? 'unknown'}:${limit}`;

    const result = hit(key, limit);
    if (!result.ok) {
      c.header('Retry-After', String(result.retryAfter));
      return c.json(
        { error: 'rate_limit_exceeded', retryAfter: result.retryAfter },
        429,
      );
    }
    await next();
  };
}

/** Rate limits tuned per phase-10 spec, tightened with the action meter
 *  (30/min writes catches reveal-loop bursts before the per-key per-day
 *  abuse layer kicks in). Reads stay at 300/min — read-only is free.
 */
export const writeRateLimit = rateLimit(30);
export const readRateLimit = rateLimit(300);

/** Exposed for tests — resets the in-memory bucket state. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
