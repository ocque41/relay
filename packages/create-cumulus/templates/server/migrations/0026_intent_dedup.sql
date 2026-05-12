-- POST /v1/intent — goal-to-env resolver.
--
-- Adds the dedup substrate that lets concurrent /v1/intent calls for the
-- same workspace + provider + alias resolve to the same account instead of
-- racing into duplicate signups.
--
-- 1. accounts.alias — nullable. NULL means "the primary account for this
--    (workspace, provider)". Aliased rows let agents pin multiple accounts
--    inside one category, e.g. {database, neon, primary} and
--    {database, neon, analytics} resolve to two distinct env vars.
--
-- 2. accounts_workspace_provider_alias_active — partial unique index on
--    (user_workspace_id, provider_id, COALESCE(alias, '')) WHERE
--    status != 'failed'. Failed rows are excluded so a previous bad signup
--    never blocks retry. Pairs with a Postgres advisory lock taken inside
--    the intent route around the dedup-check-then-insert window.
--
-- 3. intent_resolutions — Idempotency-Key cache. One row per (agent_id, key)
--    holding the response_json for 24 hours. Subsequent calls with the same
--    header return the cached payload verbatim so retries after a 5xx don't
--    fan out into duplicate signup_jobs.

ALTER TABLE "accounts"
  ADD COLUMN IF NOT EXISTS "alias" text;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_workspace_provider_alias_active"
  ON "accounts" ("user_workspace_id", "provider_id", COALESCE("alias", ''))
  WHERE "status" != 'failed';--> statement-breakpoint

-- Mirror alias on signup_jobs so the intent route can detect an in-flight
-- provision for the same (workspace, provider, alias) and avoid kicking a
-- duplicate workflow that would only crash on the unique index above.
ALTER TABLE "signup_jobs"
  ADD COLUMN IF NOT EXISTS "alias" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_signup_jobs_dedup_lookup"
  ON "signup_jobs" ("user_workspace_id", "provider_slug", "alias", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "intent_resolutions" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"      uuid        NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "key"           text        NOT NULL,
  "response_json" jsonb       NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"    timestamptz NOT NULL
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "intent_resolutions_agent_key_key"
  ON "intent_resolutions" ("agent_id", "key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_intent_resolutions_expires_at"
  ON "intent_resolutions" ("expires_at");
