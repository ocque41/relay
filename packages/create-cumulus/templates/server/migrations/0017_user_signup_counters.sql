-- Per-user monthly signup counter + admin override column.
--
-- Abuse prevention for the integrator-only revenue model. End-users pay
-- nothing, so a malicious agent can otherwise burn through every
-- integrator's quota by spamming signups. The counter caps one user's
-- lifetime-reset calendar-month signup count; the admin override column
-- lets ops raise the limit for a vetted power-user without rebuilding.

-- Per (user_id, period_ym) row. period_ym is ISO 'YYYY-MM' so rollover is
-- trivial: a new INSERT ON CONFLICT bumps the right bucket without needing
-- a sweep cron. The rows stay forever for audit purposes; the absolute
-- storage is bounded by active users × months-live.
CREATE TABLE IF NOT EXISTS "user_signup_counts" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_ym" text NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "period_ym")
);

CREATE INDEX IF NOT EXISTS "user_signup_counts_period_idx"
  ON "user_signup_counts" ("period_ym");

-- Admin override: raise the cap for a specific user. NULL means "use the
-- env default (USER_SIGNUP_MONTHLY_LIMIT)".
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "signup_limit_override" integer;
