-- Repeat-user fairness debounce for key-lifecycle actions.
--
-- After an end-user's first signup, a single (user, tenant, provider)
-- triple gets debounced to one billed integrator action per UTC day for
-- key-lifecycle actions (mint / reveal / rotate / revoke). The first
-- such action of the day debits one slot; subsequent same-day,
-- same-triple actions are free against integrator quota. Per-user abuse
-- caps still run on top — this only changes how often integrator quota
-- is debited.
--
-- Signups, deletes, and re-signups are NOT debounced and continue to
-- bill once each.
--
-- Toggle: BILLING_FAIRNESS=on (default) to enable; `off` to skip the
-- debounce entirely (every key-lifecycle action bills).

CREATE TABLE IF NOT EXISTS "user_provider_action_days" (
  "user_id"          uuid        NOT NULL REFERENCES "users"("id")   ON DELETE CASCADE,
  "tenant_id"        uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "provider_id"      text        NOT NULL,
  "ymd_utc"          date        NOT NULL,
  "first_action_at"  timestamptz NOT NULL DEFAULT now(),
  "action_count"     integer     NOT NULL DEFAULT 0,
  CONSTRAINT "user_provider_action_days_pkey"
    PRIMARY KEY ("user_id", "tenant_id", "provider_id", "ymd_utc")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_upad_tenant_ymd"
  ON "user_provider_action_days" ("tenant_id", "ymd_utc");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_upad_ymd"
  ON "user_provider_action_days" ("ymd_utc");
