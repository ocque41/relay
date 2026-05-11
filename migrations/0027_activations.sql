-- Founding-partner sprint + activation tracking.
--
-- 1. signup_jobs.handoff_at — non-nullable-by-purpose timestamp stamped
--    only at the genuine deliver-once handoff write site
--    (src/server/routes/signups.ts and src/mcp/server.ts). The existing
--    `credentials_delivered_at` column is also stamped by the cron-driven
--    24h scrub (routes/cron.ts) which makes it semantically ambiguous for
--    activation accounting: a row may carry credentials_delivered_at
--    without the agent ever having received the credentials. handoff_at
--    is reserved for the case where a caller actually retrieved the
--    plaintext, and is the ground-truth join key for the 24h activation
--    rule.
--
-- 2. tenant_tracking_secrets — per-tenant, low-privilege HMAC secret used
--    by the @relay/track SDK to authenticate POST /v1/activations. Scope
--    is intentionally narrow: this secret cannot mint API keys, read
--    accounts, or call any other route. It can ONLY write activation
--    events. Multiple non-revoked rows per tenant let manual rotation
--    accept both old and new secrets during a short grace window
--    (`grace_until`). Validation: lookup any non-revoked row whose
--    secret_hash matches and whose grace_until is null or in the future.
--
-- 3. activations — one row per integrator-reported activation event.
--    Idempotent on (tenant_id, idempotency_key). Joins on signup_id
--    (primary), and computes is_24h against signup_jobs.handoff_at.
--    The 7d window is also computed and stored so cohort reports can
--    show both rates without re-reading signup_jobs. metadata_redacted
--    holds normalized fields only — never raw integrator payloads.
--
-- 4. tenants.partnership_status — enumerated lifecycle for the founding-
--    partner sprint funnel. NULL = not yet a paying prospect; 'sprint_paid'
--    = checkout completed; 'renewed' = month-to-month subscription kicked
--    in; 'lapsed' = sprint ended without renewal. Stripe webhook flips
--    NULL→'sprint_paid' on checkout.session.completed for the founding-
--    partner SKU.

ALTER TABLE "signup_jobs"
  ADD COLUMN IF NOT EXISTS "handoff_at" timestamp with time zone;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_signup_jobs_handoff_at"
  ON "signup_jobs" ("handoff_at");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_tracking_secrets" (
  "id"            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"     uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Public identifier handed to the integrator alongside the secret. Sent
  -- on every POST /v1/activations request via X-Relay-Secret-Id so the
  -- server knows which secret to verify against without scanning the table.
  "public_id"     text        NOT NULL,
  -- Plaintext secret used to compute HMAC signatures. Stored at rest
  -- (Stripe restricted-key pattern). Never echoed back in API responses.
  "secret_value"  text        NOT NULL,
  "label"         text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "revoked_at"    timestamptz,
  "grace_until"   timestamptz
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "tenant_tracking_secrets_public_id_key"
  ON "tenant_tracking_secrets" ("public_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tenant_tracking_secrets_tenant"
  ON "tenant_tracking_secrets" ("tenant_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "activations" (
  "id"                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"           uuid        NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "signup_id"           uuid        NOT NULL REFERENCES "signup_jobs"("id") ON DELETE CASCADE,
  "account_id"          uuid        REFERENCES "accounts"("id") ON DELETE SET NULL,
  "external_user_id"    text,
  "provider_key_id"     uuid,
  "event_name"          text        NOT NULL DEFAULT 'authenticated_api_call_succeeded',
  "occurred_at"         timestamptz NOT NULL,
  "received_at"         timestamptz NOT NULL DEFAULT now(),
  "idempotency_key"     text        NOT NULL,
  "metadata_redacted"   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  "is_24h"              boolean     NOT NULL DEFAULT false,
  "is_7d"               boolean     NOT NULL DEFAULT false
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "activations_tenant_idem_key"
  ON "activations" ("tenant_id", "idempotency_key");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_activations_signup_id"
  ON "activations" ("signup_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_activations_tenant_occurred"
  ON "activations" ("tenant_id", "occurred_at");--> statement-breakpoint

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "partnership_status" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tenants_partnership_status"
  ON "tenants" ("partnership_status");
