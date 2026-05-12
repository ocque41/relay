-- Actions API: per-tenant product-action registry + execution ledger.
-- Lets agents invoke domain-specific buttons (publish, add-to-cart, etc.) in
-- integrator products via Relay, with HMAC-signed outbound dispatch, a 1-token
-- per-call user charge, and a per-month tenant volume quota that soft-caps at
-- 110 % then returns 429 past that.

-- 1) actions: per-tenant registry (NOT a generalization of tenant_providers).
--    UNIQUE (tenant_id, slug) is the correction from tenant_providers, which
--    erroneously made slug globally unique — two integrators must be able to
--    both expose `publish`.
CREATE TABLE IF NOT EXISTS "actions" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id"           uuid NOT NULL,
  "slug"                text NOT NULL,
  "display_name"        text NOT NULL,
  "description"         text,
  "endpoint_url"        text NOT NULL,
  "endpoint_method"     text NOT NULL DEFAULT 'POST',
  "input_schema"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_schema"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "webhook_secret_enc"  bytea NOT NULL,
  "timeout_ms"          integer NOT NULL DEFAULT 30000,
  "visibility"          text NOT NULL DEFAULT 'public',
  "disabled_at"         timestamp with time zone,
  "created_at"          timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"          timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "actions_visibility_check" CHECK ("visibility" IN ('public','private'))
);--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "actions_tenant_slug_key" ON "actions" ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "actions_tenant_public_idx" ON "actions" ("tenant_id") WHERE "visibility" = 'public' AND "disabled_at" IS NULL;--> statement-breakpoint

-- 2) action_invocations: execute-time ledger + idempotency store.
--    status state machine: dispatched -> {succeeded | failed | unknown}.
--    'overage' (soft-cap run) and 'quota_denied' (429 refusal) are terminal.
--    idempotency_key is client-supplied (Idempotency-Key header, Stripe-style);
--    the partial unique index lets rows without a key coexist freely.
CREATE TABLE IF NOT EXISTS "action_invocations" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "action_id"          uuid NOT NULL,
  "tenant_id"          uuid NOT NULL,
  "user_id"            uuid,
  "agent_id"           uuid,
  "external_user_id"   text NOT NULL,
  "idempotency_key"    text,
  "status"             text NOT NULL,
  "latency_ms"         integer,
  "error"              text,
  "charge_event_id"    uuid,
  "created_at"         timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at"       timestamp with time zone,
  CONSTRAINT "action_invocations_status_check" CHECK ("status" IN ('dispatched','succeeded','failed','unknown','quota_denied','overage'))
);--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_invocations" ADD CONSTRAINT "action_invocations_charge_event_id_usage_events_id_fk" FOREIGN KEY ("charge_event_id") REFERENCES "public"."usage_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_invocations_tenant_created_idx" ON "action_invocations" ("tenant_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_invocations_idem_key" ON "action_invocations" ("tenant_id","action_id","external_user_id","idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "action_invocations_dispatched_idx" ON "action_invocations" ("created_at") WHERE "status" = 'dispatched';--> statement-breakpoint

-- 3) tenant_subscriptions: per-month action counter + reset timestamp.
--    actions_included: the plan's cap (-1 == unlimited). 0 == no plan
--    override (falls back to pricing_config.plan_quotas lookup at charge time).
--    period_resets_at is checked & rolled inside the atomic execute UPDATE,
--    so no separate cron is needed.
ALTER TABLE "tenant_subscriptions" ADD COLUMN "actions_included" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN "actions_used_period" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tenant_subscriptions" ADD COLUMN "period_resets_at" timestamp with time zone;--> statement-breakpoint

-- 4) pricing_config: plan quotas + action_execute price.
--    plan_quotas is keyed by the same plan slug `tenant_subscriptions.plan`
--    carries (founders | starter | growth | scale).
ALTER TABLE "pricing_config" ADD COLUMN "plan_quotas" jsonb NOT NULL DEFAULT '{}'::jsonb;--> statement-breakpoint

UPDATE "pricing_config"
   SET "prices"      = "prices" || '{"action_execute":1}'::jsonb,
       "plan_quotas" = '{
         "founders": {"actions_per_month": 5000},
         "starter":  {"actions_per_month": 25000},
         "growth":   {"actions_per_month": 150000},
         "scale":    {"actions_per_month": -1}
       }'::jsonb
 WHERE "id" = 'default';--> statement-breakpoint

-- 5) Backfill actions_included + period_resets_at on existing subscriptions so
--    already-active tenants don't hit quota 0 the moment the code rolls out.
UPDATE "tenant_subscriptions" ts
   SET "actions_included"  = COALESCE(
         ((SELECT "plan_quotas" FROM "pricing_config" WHERE "id" = 'default')
           -> ts."plan" ->> 'actions_per_month')::int,
         0),
       "period_resets_at"  = COALESCE(ts."current_period_end", now() + interval '30 days');
