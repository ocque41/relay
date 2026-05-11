-- Drop-in API: multi-tenancy + external-identity mapping.
-- Foundation for letting any integrator bolt Relay onto its existing auth.
-- Adds:
--   * tenants: `domain`, `rp_id`, `allowed_origins` for discovery + CORS + RP config.
--   * agents:  `tenant_id` so a bearer can be pinned to an integrator (scopes=['integrator']).
--   * user_external_identities: joins one Relay user to one integrator-local user ID per tenant.

-- 1) tenants: discovery + CORS + WebAuthn RP fields. All nullable or defaulted
--    so existing tenant rows keep working without a data backfill.
ALTER TABLE "tenants" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "rp_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "allowed_origins" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_domain_unique" UNIQUE ("domain");--> statement-breakpoint

-- 2) agents: optional tenant pin. Integrator keys carry scopes=['integrator']
--    AND tenant_id=<pinned>; the requireIntegratorKey middleware requires both.
--    On tenant deletion the pinned integrator key cascades (keys without a
--    tenant remain untouched since tenant_id is nullable).
ALTER TABLE "agents" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_tenant_id_idx" ON "agents" ("tenant_id") WHERE "tenant_id" IS NOT NULL;--> statement-breakpoint

-- 3) user_external_identities: one Relay user ↔ one integrator-local user ID per tenant.
--    Populated on first attest (Flow 2) or first server-to-server integrator call (Flow 4).
--    Two uniqueness guarantees:
--      * (tenant_id, external_user_id) unique — integrator's local ID is stable
--      * (user_id, tenant_id)          unique — re-attestation returns the same external_user_id
CREATE TABLE IF NOT EXISTS "user_external_identities" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"          uuid NOT NULL,
  "tenant_id"        uuid NOT NULL,
  "external_user_id" text NOT NULL,
  "created_at"       timestamp with time zone DEFAULT now()
);--> statement-breakpoint
ALTER TABLE "user_external_identities" ADD CONSTRAINT "user_external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_external_identities" ADD CONSTRAINT "user_external_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_external_identities_tenant_external_key" ON "user_external_identities" ("tenant_id", "external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_external_identities_user_tenant_key" ON "user_external_identities" ("user_id", "tenant_id");--> statement-breakpoint

-- 4) Seed the two new billable actions into the default price book.
--    tenant_create anti-spams Flow 1 (agents that auto-create tenants).
--    attest_agent is cheap but metered so abuse is detectable in usage_events.
UPDATE "pricing_config"
   SET "prices" = "prices" || '{"tenant_create":100,"attest_agent":1}'::jsonb
 WHERE "id" = 'default';
