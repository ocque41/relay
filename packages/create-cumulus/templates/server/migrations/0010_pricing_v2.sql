-- Pricing v2: tighter plans, free-action meter, user caps, feature flags,
-- Scale E2E benchmark sampling, and a `source` tag on every usage_events row
-- so UI-initiated writes (session cookie) can be visually separated from
-- agent-initiated writes (bearer) in analytics.

-- 1) users.free_actions_remaining — per-user onboarding credit. First three
--    agent-driven charges are free (sign-in + first key + first action).
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "free_actions_remaining" integer NOT NULL DEFAULT 3;--> statement-breakpoint

-- 2) tenant_subscriptions.users_limit — per-plan max users cap.
--    -1 == unlimited (Scale / Enterprise). 0 == no plan override (falls
--    back to pricing_config.plan_quotas[plan].users_limit at attest time).
ALTER TABLE "tenant_subscriptions"
  ADD COLUMN IF NOT EXISTS "users_limit" integer NOT NULL DEFAULT 0;--> statement-breakpoint

-- 3) usage_events.source — 'api' for agent-bearer calls, 'ui' for session
--    calls (which are free). Defaults to 'api' so a missing value is
--    always the conservative case.
ALTER TABLE "usage_events"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'api';--> statement-breakpoint

-- 4) tenant_plan_features — per-tenant feature bag. Seeded on subscription
--    upsert based on plan. Scale gets scale_e2e_benchmark; Enterprise
--    packs whatever features the sales contract includes.
CREATE TABLE IF NOT EXISTS "tenant_plan_features" (
  "tenant_id"  uuid PRIMARY KEY,
  "features"   jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "tenant_plan_features" ADD CONSTRAINT "tenant_plan_features_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- 5) scale_benchmark_samples — continuous synthetic probe timings.
--    Cron-written by /v1/cron/scale-benchmark every 5 minutes for each
--    tenant with features.scale_e2e_benchmark = true.
--    stage ∈ discover | bootstrap | attest | login | execute | total.
CREATE TABLE IF NOT EXISTS "scale_benchmark_samples" (
  "id"        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "stage"     text NOT NULL,
  "latency_ms" integer NOT NULL,
  "ok"        boolean NOT NULL,
  "error"     text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "scale_benchmark_samples" ADD CONSTRAINT "scale_benchmark_samples_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scale_benchmark_samples_tenant_created_idx" ON "scale_benchmark_samples" ("tenant_id","created_at" DESC);--> statement-breakpoint

-- 6) Reseed pricing_config.plan_quotas with v2 pricing:
--    founders = $0,  5k/mo, 3 users,   60-day trial
--    starter  = $200, 50k/mo, 300 users
--    growth   = $1k, 300k/mo, 2000 users
--    scale    = $3k,  ∞/mo,   ∞ users
--    enterprise = custom (no Stripe product); flags kept -1/-1 as sentinel.
UPDATE "pricing_config"
   SET "plan_quotas" = '{
     "founders":   {"actions_per_month": 5000,   "users_limit": 3,    "trial_days": 60},
     "starter":    {"actions_per_month": 50000,  "users_limit": 300,  "trial_days": 0},
     "growth":     {"actions_per_month": 300000, "users_limit": 2000, "trial_days": 0},
     "scale":      {"actions_per_month": -1,     "users_limit": -1,   "trial_days": 0},
     "enterprise": {"actions_per_month": -1,     "users_limit": -1,   "trial_days": 0}
   }'::jsonb
 WHERE "id" = 'default';--> statement-breakpoint

-- 7) Backfill users_limit on existing active subscriptions so the Cumulus
--    founders seed and existing test tenants don't hit cap 0.
UPDATE "tenant_subscriptions" ts
   SET "users_limit" = COALESCE(
         ((SELECT "plan_quotas" FROM "pricing_config" WHERE "id" = 'default')
           -> ts."plan" ->> 'users_limit')::int,
         0);--> statement-breakpoint

-- 8) Seed tenant_plan_features for every existing tenant (empty bag — sales
--    promotes to specific flags later).
INSERT INTO "tenant_plan_features" ("tenant_id", "features")
  SELECT t."id", '{}'::jsonb FROM "tenants" t
  ON CONFLICT ("tenant_id") DO NOTHING;
