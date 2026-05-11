-- Rollback — recreate user-wallet tables EMPTY.
--
-- Run only if migration 0015 needs to be reversed post-deploy. There is no
-- data to restore: enforcement was never flipped on, so balances/usage_events
-- had nothing real in them. This script exists to let the schema drift back
-- in case a revert is needed before the follow-up code deletion lands.
--
-- DDL is copied verbatim from migrations 0007, 0011, 0012 for the relevant
-- tables; FK references use the same names. After running this, also run
-- `ALTER TABLE action_invocations ADD COLUMN charge_event_id uuid REFERENCES
-- usage_events(id) ON DELETE SET NULL;` to restore the FK.

CREATE TABLE IF NOT EXISTS "pricing_config" (
  "id" text PRIMARY KEY,
  "prices" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "token_balances" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "balance" integer NOT NULL DEFAULT 0,
  "free_balance" integer NOT NULL DEFAULT 0,
  "total_spent" integer NOT NULL DEFAULT 0,
  "free_resets_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "usage_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "tenant_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "action" text,
  "tokens_delta" integer NOT NULL,
  "balance_after" integer NOT NULL,
  "metadata" jsonb,
  "source" text NOT NULL DEFAULT 'api',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "usage_events_user_idx"
  ON "usage_events" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "usage_events_tenant_idx"
  ON "usage_events" ("tenant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "user_shared_payment_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "spt_id" text UNIQUE NOT NULL,
  "payment_method_kind" text,
  "last4" text,
  "brand" text,
  "expires_at" timestamptz,
  "per_tx_cap_cents" integer NOT NULL DEFAULT 2000,
  "monthly_cap_cents" integer NOT NULL DEFAULT 5000,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "revoked_at" timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_spt_active_key"
  ON "user_shared_payment_tokens" ("user_id")
  WHERE "status" = 'active';

CREATE TABLE IF NOT EXISTS "mpp_payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "spt_id" text,
  "stripe_payment_intent_id" text UNIQUE,
  "amount_cents" integer NOT NULL,
  "kind" text NOT NULL,
  "path" text,
  "action" text,
  "status" text NOT NULL,
  "error" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "user_issued_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "stripe_cardholder_id" text NOT NULL,
  "stripe_card_id" text UNIQUE NOT NULL,
  "last4" text,
  "status" text NOT NULL DEFAULT 'active',
  "per_tx_cap_cents" integer NOT NULL DEFAULT 5000,
  "monthly_cap_cents" integer NOT NULL DEFAULT 20000,
  "allowed_merchant_categories" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "free_actions_remaining" integer NOT NULL DEFAULT 3;
