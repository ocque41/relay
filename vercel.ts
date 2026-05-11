import type { VercelConfig } from '@vercel/config/v1';

// Explicitly set the framework so Vercel uses the Next.js build output.
// Previously this was `framework: null` (Nitro era) — leaving it unset keeps
// an older setting cached on the Vercel project, which served 404s on every
// route. `framework: 'nextjs'` forces the correct detection.
//
// Hono is mounted as catch-all Next.js Route Handlers under `app/v1/**`,
// `app/mcp`, `app/health`, `app/openapi.json`, and `app/docs`. The Workflow
// DevKit's `/.well-known/workflow/v1/*` endpoints are registered by
// `withWorkflow()` wrapping `next.config.ts`.
export const config: VercelConfig = {
  framework: 'nextjs',
  // GC expired OTPs, WebAuthn challenges, sessions, CLI device codes, and
  // signup confirmations daily at 03:00 UTC. The endpoint is idempotent.
  // (Vercel Hobby tier limits crons to once per day; upgrade to Pro for more.)
  crons: [
    { path: '/v1/cron/gc', schedule: '0 3 * * *' },
    // Pricing v2: sample Relay-internal latency for every Scale-plan tenant.
    // Hobby tier caps crons at once/day — this runs at 00:05 UTC daily.
    // Upgrade to Pro and switch to `*/5 * * * *` for real-time SLA sampling.
    { path: '/v1/cron/scale-benchmark', schedule: '5 0 * * *' },
    // Push queued per-signup overage charges to Stripe invoice items on the
    // 1st of every month at 01:00 UTC. Idempotent — Stripe de-dupes via the
    // signup_job_id metadata + our idempotency key.
    { path: '/v1/cron/flush-overage', schedule: '0 1 1 * *' },
  ],
};
