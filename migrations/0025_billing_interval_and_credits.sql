-- Yearly billing intervals + tenant-paid credit packs.
--
-- 1. tenant_subscriptions gains a `billing_interval` column derived from
--    Stripe (`subscription.items.data[0].price.recurring.interval`).
--    Existing rows backfill to 'monthly' via the column DEFAULT.
--
-- 2. action_credits is a per-tenant prepaid ledger. An integrator who has
--    burned through their plan's monthly quota can buy a one-shot credit
--    pack from /v1/dev/billing/credits/checkout. Stripe Checkout completes,
--    the webhook inserts a row, and `requireIntegratorQuota` then prefers
--    these credits over the overage queue.
--
-- 3. action_credit_consumptions is the per-action audit log so a refund
--    keyed on idempotency_key can return the exact credit slot that was
--    spent. Indexed on (tenant_id, idempotency_key) for O(1) lookup; the
--    UNIQUE constraint also makes refund idempotent.
--
-- Customer-facing impact:
--   - existing monthly tenants: zero. They keep monthly, billing_interval
--     defaults to 'monthly'.
--   - new tenants: can pick monthly or yearly at checkout.
--   - any tenant: can buy a credit pack any time.

-- 1. Yearly support on tenant_subscriptions.
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "billing_interval" text NOT NULL DEFAULT 'monthly';--> statement-breakpoint

ALTER TABLE "tenant_subscriptions"
  ADD CONSTRAINT "tenant_subscriptions_billing_interval_check"
  CHECK ("billing_interval" IN ('monthly', 'yearly'));--> statement-breakpoint

-- 2. action_credits — per-tenant prepaid credit-pack ledger.
CREATE TABLE IF NOT EXISTS "action_credits" (
  "id"                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                   uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "pack_id"                     text        NOT NULL,
  "actions_purchased"           integer     NOT NULL,
  "actions_remaining"           integer     NOT NULL,
  "amount_cents_paid"           integer     NOT NULL,
  "stripe_payment_intent_id"    text        UNIQUE,
  "stripe_checkout_session_id"  text,
  "expires_at"                  timestamptz NOT NULL,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "action_credits_pack_id_check"
    CHECK ("pack_id" IN ('builder','starter','growth','scale')),
  CONSTRAINT "action_credits_remaining_nonnegative"
    CHECK ("actions_remaining" >= 0),
  CONSTRAINT "action_credits_remaining_le_purchased"
    CHECK ("actions_remaining" <= "actions_purchased")
);--> statement-breakpoint

-- Partial index: covers the FIFO consumption query that runs on every
-- billable action when the plan pool is empty.
CREATE INDEX IF NOT EXISTS "action_credits_tenant_remaining_expires_idx"
  ON "action_credits" ("tenant_id", "expires_at" ASC)
  WHERE "actions_remaining" > 0;--> statement-breakpoint

-- 3. action_credit_consumptions — per-action audit log so refunds can
-- restore the exact credit slot that was spent.
CREATE TABLE IF NOT EXISTS "action_credit_consumptions" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "action_credit_id"    uuid        NOT NULL REFERENCES "action_credits"("id") ON DELETE CASCADE,
  "idempotency_key"     text        NOT NULL UNIQUE,
  "consumed_at"         timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "action_credit_consumptions_tenant_idx"
  ON "action_credit_consumptions" ("tenant_id");
