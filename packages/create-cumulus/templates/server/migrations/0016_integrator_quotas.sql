-- Integrator signup quotas + overage billing.
--
-- The new revenue model: integrators pay a monthly subscription that includes
-- a fixed number of delivered signups. Signups past the included quota bill
-- as usage-based overage via a per-signup Stripe invoice item, flushed
-- monthly by /v1/cron/flush-overage. The SLA on Scale and Enterprise tiers
-- remains inherited from tenant_plan_features.

-- --------------------------------------------------------------------------
-- plan_catalog — source of truth for plan pricing + included quota.
--
-- Seeded with six rows (Founders trial, Builder, Starter, Growth, Scale,
-- Enterprise placeholder). Operators can UPDATE price_cents /
-- included_signups in-place; the webhook upsert re-reads on every
-- subscription event, so price changes land on the next Stripe billing
-- cycle without a redeploy.
--
-- trial_signups / trial_days are both NULL for paid tiers; Founders carries
-- (30, 60) — "30 delivered signups OR 60 days, whichever ends first".
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "plan_catalog" (
  "id" text PRIMARY KEY,
  "display_name" text NOT NULL,
  "price_cents" integer NOT NULL,
  "included_signups" integer NOT NULL,
  "overage_price_cents" integer NOT NULL,
  "trial_signups" integer,
  "trial_days" integer,
  "sla_target" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "plan_catalog"
  ("id", "display_name", "price_cents", "included_signups", "overage_price_cents", "trial_signups", "trial_days", "sla_target")
VALUES
  ('founders',   'Founders (trial)',  0,       30,      0,   30, 60, NULL),
  ('builder',    'Builder',           4900,    100,     49,  NULL, NULL, NULL),
  ('starter',    'Starter',           19900,   500,     40,  NULL, NULL, NULL),
  ('growth',     'Growth',            99900,   3000,    33,  NULL, NULL, NULL),
  ('scale',      'Scale',             299900,  15000,   25,  NULL, NULL, '99.9%'),
  ('enterprise', 'Enterprise',        0,       -1,      0,   NULL, NULL, '99.95%')
ON CONFLICT ("id") DO NOTHING;

-- --------------------------------------------------------------------------
-- tenant_quota_state — per-tenant signup counter for the current billing
-- period. Exactly one row per tenant. Webhooks reset it on
-- invoice.payment_succeeded (new period); the workflow decrements it on
-- dispatch and increments on failure.
--
-- `included_remaining` counts down toward zero. `overage_count` is the
-- number of paid-overage signups queued for the next invoice flush.
-- `period_start` / `period_end` bound the billing window; mirror what's
-- on tenant_subscriptions.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "tenant_quota_state" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "period_start" timestamptz NOT NULL,
  "period_end" timestamptz NOT NULL,
  "included_remaining" integer NOT NULL DEFAULT 0,
  "overage_count" integer NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Partial index for the "my period end" lookup used by the flush cron.
CREATE INDEX IF NOT EXISTS "tenant_quota_state_period_end_idx"
  ON "tenant_quota_state" ("period_end");

-- --------------------------------------------------------------------------
-- stripe_pending_invoice_items — queue of per-signup overage charges that
-- haven't been pushed to Stripe yet. Flushed monthly by the cron at
-- /v1/cron/flush-overage. Keyed on signup_job_id (UNIQUE) so double-
-- delivery of the same overage is a no-op.
-- --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "stripe_pending_invoice_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "signup_job_id" uuid NOT NULL UNIQUE,
  "amount_cents" integer NOT NULL,
  "stripe_subscription_id" text,
  "flushed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "stripe_pending_invoice_items_tenant_flushed_idx"
  ON "stripe_pending_invoice_items" ("tenant_id", "flushed_at");

-- --------------------------------------------------------------------------
-- Grandfather every existing tenant into a Founders trial quota state so
-- the first dispatch after this migration succeeds. The periods are
-- re-anchored by the next subscription webhook (invoice.payment_succeeded /
-- customer.subscription.updated).
-- --------------------------------------------------------------------------
INSERT INTO "tenant_quota_state"
  ("tenant_id", "period_start", "period_end", "included_remaining", "overage_count")
SELECT
  t."id",
  now()                                 AS "period_start",
  now() + interval '60 days'            AS "period_end",
  30                                    AS "included_remaining",
  0                                     AS "overage_count"
FROM "tenants" AS t
WHERE NOT EXISTS (
  SELECT 1 FROM "tenant_quota_state" AS s WHERE s."tenant_id" = t."id"
);
