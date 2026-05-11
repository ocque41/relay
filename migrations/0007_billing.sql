-- Billing data model. Wallet, append-only ledger, price book,
-- tenant subscriptions, and subscription event log.

-- Per-user prepaid wallet. Atomic decrement is the security gate.
CREATE TABLE IF NOT EXISTS "token_balances" (
  "user_id"         uuid PRIMARY KEY NOT NULL,
  "balance"         integer NOT NULL DEFAULT 0,
  "free_balance"    integer NOT NULL DEFAULT 0,
  "free_resets_at"  timestamp with time zone,
  "total_topped_up" integer NOT NULL DEFAULT 0,
  "total_spent"     integer NOT NULL DEFAULT 0,
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "token_balances" ADD CONSTRAINT "token_balances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Append-only ledger. Every charge / refund / top-up / free_grant writes a row.
CREATE TABLE IF NOT EXISTS "usage_events" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"       uuid NOT NULL,
  "tenant_id"     uuid,
  "kind"          text NOT NULL,
  "action"        text NOT NULL,
  "tokens_delta"  integer NOT NULL,
  "balance_after" integer NOT NULL,
  "metadata"      jsonb,
  "created_at"    timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_user_idx" ON "usage_events" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_tenant_idx" ON "usage_events" ("tenant_id", "created_at" DESC) WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint

-- Price book. JSON-shaped so admin can edit without code deploys.
CREATE TABLE IF NOT EXISTS "pricing_config" (
  "id"             text PRIMARY KEY NOT NULL,
  "prices"         jsonb NOT NULL,
  "topup_packages" jsonb NOT NULL,
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Tenant subscription state. Only one active row per tenant at a time;
-- past rows kept for history.
CREATE TABLE IF NOT EXISTS "tenant_subscriptions" (
  "id"                     uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"              uuid NOT NULL,
  "status"                 text NOT NULL,
  "plan"                   text NOT NULL,
  "stripe_subscription_id" text,
  "stripe_customer_id"     text,
  "current_period_end"     timestamp with time zone,
  "trial_ends_at"          timestamp with time zone,
  "canceled_at"            timestamp with time zone,
  "created_at"             timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"             timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "tenant_subscriptions_stripe_subscription_id_unique" UNIQUE ("stripe_subscription_id")
);--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD CONSTRAINT "tenant_subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenant_subscriptions_tenant_active_idx" ON "tenant_subscriptions" ("tenant_id") WHERE "status" IN ('trialing','active');--> statement-breakpoint

-- Audit of subscription state changes (Stripe webhook → row).
CREATE TABLE IF NOT EXISTS "subscription_events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subscription_id" uuid NOT NULL,
  "event_type"      text NOT NULL,
  "stripe_event_id" text,
  "metadata"        jsonb,
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "subscription_events_stripe_event_id_unique" UNIQUE ("stripe_event_id")
);--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_tenant_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."tenant_subscriptions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Seed the default price book. Numbers are placeholders; tune after launch.
INSERT INTO "pricing_config" ("id", "prices", "topup_packages") VALUES (
  'default',
  '{"signup_create":10,"key_create":5,"key_deliver":0,"account_delete":0,"share_link":1}'::jsonb,
  '[{"id":"starter","cents":500,"tokens":1000,"label":"Starter"},{"id":"growth","cents":2000,"tokens":5000,"label":"Growth"},{"id":"scale","cents":10000,"tokens":30000,"label":"Scale"}]'::jsonb
) ON CONFLICT ("id") DO NOTHING;
