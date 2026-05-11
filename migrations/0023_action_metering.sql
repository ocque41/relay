-- Pricing re-meter to "actions" (broader unit covering signup +
-- reveal + revoke + delete) plus new abuse-control tables.
--
-- Customer-facing changes:
--   * plan_catalog.included_signups -> included_actions (rename)
--   * plan_catalog.trial_signups    -> trial_actions    (rename)
--   * Plan rows updated to the new ladder (Builder 1k / Starter 10k /
--     Growth 50k / Scale 300k / Founders 100).
--
-- Abuse layers:
--   * users.action_limit_override   — per-user raise (mirror of
--     signup_limit_override).
--   * tenants.paused_at             — manual kill switch.
--   * user_action_counts            — per-user-month action counter
--     (mirror of user_signup_counts).
--   * stripe_pending_invoice_items.idempotency_key — generic key (was
--     signup_job_id, kept-as-text-alias) so reveal/revoke/delete overage
--     rows can use any unique identifier.
--
-- Tenant quota state (`tenant_quota_state.included_remaining`) is NOT
-- modified here. Existing tenants keep their current period; the next
-- Stripe webhook (`resetQuotaForPeriod`) reads the new
-- `included_actions` and resets to the larger pool. Pilot tenants
-- flipped via `BILLING_METER=actions` should be re-quota'd manually at
-- flip time.

-- 1. Rename plan_catalog columns.
ALTER TABLE "plan_catalog"
  RENAME COLUMN "included_signups" TO "included_actions";--> statement-breakpoint

ALTER TABLE "plan_catalog"
  RENAME COLUMN "trial_signups" TO "trial_actions";--> statement-breakpoint

-- 2. Update plan rows to the new ladder. Keep monthly prices unchanged
-- (Stripe Price IDs unchanged) but inflate quotas and re-anchor overage
-- to the in-quota effective rate.
--
-- Founders (trial):    100 actions / 60 days, no overage.
-- Builder $49:       1,000 actions / month, 5¢ overage  ($0.049/action).
-- Starter $199:     10,000 actions / month, 2¢ overage  ($0.020/action).
-- Growth  $999:     50,000 actions / month, 2¢ overage  ($0.020/action).
-- Scale  $2999:    300,000 actions / month, 1¢ overage  ($0.010/action).
-- Enterprise: unchanged (custom).
UPDATE "plan_catalog" SET "included_actions" = 100,    "overage_price_cents" = 0,  "trial_actions" = 100  WHERE "id" = 'founders';--> statement-breakpoint
UPDATE "plan_catalog" SET "included_actions" = 1000,   "overage_price_cents" = 5             WHERE "id" = 'builder';--> statement-breakpoint
UPDATE "plan_catalog" SET "included_actions" = 10000,  "overage_price_cents" = 2             WHERE "id" = 'starter';--> statement-breakpoint
UPDATE "plan_catalog" SET "included_actions" = 50000,  "overage_price_cents" = 2             WHERE "id" = 'growth';--> statement-breakpoint
UPDATE "plan_catalog" SET "included_actions" = 300000, "overage_price_cents" = 1             WHERE "id" = 'scale';--> statement-breakpoint

-- 3. Per-user-month action counter (mirror of user_signup_counts).
CREATE TABLE IF NOT EXISTS "user_action_counts" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "period_ym" text NOT NULL,
  "count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "period_ym")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "user_action_counts_period_idx"
  ON "user_action_counts" ("period_ym");--> statement-breakpoint

-- 4. Per-user action-limit override (mirror of signup_limit_override).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "action_limit_override" integer;--> statement-breakpoint

-- 5. Tenant kill-switch — set by ops to instantly pause a runaway tenant
-- without touching their Stripe subscription. Charge middleware reads
-- this and short-circuits to 503.
ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "paused_at" timestamptz;--> statement-breakpoint

-- 6. Generic idempotency_key on the overage queue so non-signup actions
-- (reveal/revoke/delete) can claim slots. Existing rows used signup_jobs
-- UUIDs which are valid generic keys; we cast through text and add a
-- companion column. Keeping signup_job_id around (nullable) for
-- backward-compat readers and for the cron's debug logging.
ALTER TABLE "stripe_pending_invoice_items"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint

UPDATE "stripe_pending_invoice_items"
   SET "idempotency_key" = "signup_job_id"::text
 WHERE "idempotency_key" IS NULL;--> statement-breakpoint

ALTER TABLE "stripe_pending_invoice_items"
  ALTER COLUMN "idempotency_key" SET NOT NULL;--> statement-breakpoint

-- Old UNIQUE on signup_job_id stays for backward compat. Add a UNIQUE on
-- idempotency_key for the new path.
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_pending_invoice_items_idempotency_key_key"
  ON "stripe_pending_invoice_items" ("idempotency_key");--> statement-breakpoint

-- signup_job_id becomes nullable so non-signup overages don't need to
-- forge a fake signup_jobs FK.
ALTER TABLE "stripe_pending_invoice_items"
  ALTER COLUMN "signup_job_id" DROP NOT NULL;
