/**
 * Per-action circuit breaker. In-memory, per-process (Vercel Fluid Compute
 * reuses function instances so this is effective within a warm instance).
 *
 * Rolling 1-minute window of outcomes. Once the error rate exceeds 50 %
 * with a minimum sample size, the breaker opens and `shouldBreak()` returns
 * true for 30 seconds. That short-circuits the execute path to 502 without
 * charging the user or hammering a degraded integrator.
 */
const WINDOW_MS = 60_000;
const OPEN_DURATION_MS = 30_000;
const MIN_SAMPLES = 10;
const ERROR_RATE_THRESHOLD = 0.5;

interface Bucket {
  events: Array<{ t: number; ok: boolean }>;
  openedUntil: number;
}

const buckets = new Map<string, Bucket>();

function getBucket(key: string): Bucket {
  let b = buckets.get(key);
  if (!b) {
    b = { events: [], openedUntil: 0 };
    buckets.set(key, b);
  }
  return b;
}

function pruneOld(b: Bucket, now: number): void {
  const cutoff = now - WINDOW_MS;
  while (b.events.length > 0 && b.events[0].t < cutoff) {
    b.events.shift();
  }
}

/** Record one outcome. Call after every integrator dispatch attempt. */
export function recordOutcome(actionId: string, ok: boolean): void {
  const now = Date.now();
  const b = getBucket(actionId);
  pruneOld(b, now);
  b.events.push({ t: now, ok });

  // Don't trigger off too-small samples.
  if (b.events.length < MIN_SAMPLES) return;
  if (b.openedUntil > now) return;

  const failures = b.events.filter((e) => !e.ok).length;
  const rate = failures / b.events.length;
  if (rate >= ERROR_RATE_THRESHOLD) {
    b.openedUntil = now + OPEN_DURATION_MS;
  }
}

/** `true` iff the breaker is currently open for this action. */
export function shouldBreak(actionId: string): boolean {
  const b = buckets.get(actionId);
  if (!b) return false;
  return b.openedUntil > Date.now();
}
