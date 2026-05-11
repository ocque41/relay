-- Hot-path indexes.
--
-- signup_jobs already has (user_id) from migration 0005; the composite
-- (user_id, created_at DESC) is what the "my recent signups" query
-- actually uses. (status) scans are needed for cron sweeps of
-- awaiting_email / failed rows. api_keys has no index at all on account_id,
-- which makes the account-detail key list a sequential scan.

CREATE INDEX IF NOT EXISTS "signup_jobs_user_created_idx"
  ON "signup_jobs" ("user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "signup_jobs_status_idx"
  ON "signup_jobs" ("status");

CREATE INDEX IF NOT EXISTS "api_keys_account_idx"
  ON "api_keys" ("account_id");
