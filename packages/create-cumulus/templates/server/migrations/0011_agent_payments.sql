-- Agent-driven payments: Stripe Shared Payment Tokens (SPT), Machine Payments
-- Protocol (MPP) receipts, and per-user Issuing cards (scaffolding only).
--
-- Why: Pricing v2 shipped the token wallet + subscriptions. This migration
-- unlocks an end user's AI agent to top up the wallet / upgrade the plan
-- autonomously by presenting a user-consented SPT at an agent-callable
-- autopay endpoint. Stripe enforces the per-transaction cap + expiration;
-- Relay enforces the monthly cap.

-- 1) user_shared_payment_tokens: one active SPT per user. Re-setup revokes
--    the old row (partial unique index on status='active').
CREATE TABLE IF NOT EXISTS "user_shared_payment_tokens" (
  "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"               uuid NOT NULL,
  "spt_id"                text NOT NULL,
  "payment_method_kind"   text,
  "last4"                 text,
  "brand"                 text,
  "expires_at"            timestamp with time zone,
  "per_tx_cap_cents"      integer NOT NULL DEFAULT 2000,
  "monthly_cap_cents"     integer NOT NULL DEFAULT 5000,
  "status"                text NOT NULL DEFAULT 'active',
  "created_at"            timestamp with time zone NOT NULL DEFAULT now(),
  "revoked_at"            timestamp with time zone,
  CONSTRAINT "user_spt_status_check" CHECK ("status" IN ('active','revoked','expired')),
  CONSTRAINT "user_spt_spt_id_unique" UNIQUE ("spt_id")
);--> statement-breakpoint
ALTER TABLE "user_shared_payment_tokens" ADD CONSTRAINT "user_spt_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_spt_active_key" ON "user_shared_payment_tokens" ("user_id") WHERE "status" = 'active';--> statement-breakpoint

-- 2) mpp_payments: receipts for both SPT-backed autopay (topup + subscribe)
--    and MPP per-call charges. Separate from usage_events so the Stripe-side
--    idempotency (PaymentIntent id unique) is cleanly modeled.
CREATE TABLE IF NOT EXISTS "mpp_payments" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"                  uuid,
  "spt_id"                   text,
  "stripe_payment_intent_id" text UNIQUE,
  "amount_cents"             integer NOT NULL,
  "kind"                     text NOT NULL,
  "path"                     text,
  "action"                   text,
  "status"                   text NOT NULL,
  "error"                    text,
  "created_at"               timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "mpp_payments_kind_check" CHECK ("kind" IN ('topup_autopay','subscribe_autopay','mpp_call')),
  CONSTRAINT "mpp_payments_status_check" CHECK ("status" IN ('succeeded','failed','requires_action','pending'))
);--> statement-breakpoint
ALTER TABLE "mpp_payments" ADD CONSTRAINT "mpp_payments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mpp_payments_user_created_idx" ON "mpp_payments" ("user_id","created_at" DESC);--> statement-breakpoint

-- 3) user_issued_cards: schema-only scaffolding for Stripe Issuing.
--    Ships now so the data shape is stable when we light up card-issuing
--    for agents to spend on third-party merchants on the user's behalf.
CREATE TABLE IF NOT EXISTS "user_issued_cards" (
  "id"                            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"                       uuid NOT NULL,
  "stripe_cardholder_id"          text NOT NULL,
  "stripe_card_id"                text NOT NULL UNIQUE,
  "last4"                         text,
  "status"                        text NOT NULL DEFAULT 'active',
  "per_tx_cap_cents"              integer NOT NULL DEFAULT 5000,
  "monthly_cap_cents"             integer NOT NULL DEFAULT 20000,
  "allowed_merchant_categories"   jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at"                    timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "user_issued_cards" ADD CONSTRAINT "user_issued_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
