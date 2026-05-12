-- Dual-workspace foundation. Adds ownership FKs to signup_jobs,
-- accounts, audit_log so rows can be filtered by end-user (kind=user) or
-- developer tenant (kind=tenant) without fragile joins. Also adds an
-- ephemeral credential buffer on signup_jobs so the initial provider API
-- key is delivered to the calling agent exactly once and then forgotten.

ALTER TABLE "signup_jobs" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD COLUMN "calling_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD COLUMN "provider_slug" text;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD COLUMN "pending_credentials_enc" bytea;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD COLUMN "credentials_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD CONSTRAINT "signup_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD CONSTRAINT "signup_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_jobs" ADD CONSTRAINT "signup_jobs_calling_agent_id_agents_id_fk" FOREIGN KEY ("calling_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_jobs_user_id_idx" ON "signup_jobs" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signup_jobs_tenant_id_idx" ON "signup_jobs" ("tenant_id");--> statement-breakpoint

ALTER TABLE "accounts" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_user_id_idx" ON "accounts" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_tenant_id_idx" ON "accounts" ("tenant_id");--> statement-breakpoint

ALTER TABLE "audit_log" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_user_id_idx" ON "audit_log" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_log_tenant_id_idx" ON "audit_log" ("tenant_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "magic_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "purpose" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "claimed_at" timestamp with time zone,
  "max_uses" integer NOT NULL DEFAULT 1,
  "used_count" integer NOT NULL DEFAULT 0,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "magic_links_user_id_idx" ON "magic_links" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tenant_feature_flags" (
  "tenant_id" uuid NOT NULL,
  "flag" text NOT NULL,
  "enabled_at" timestamp with time zone NOT NULL DEFAULT now(),
  "enabled_by" uuid,
  CONSTRAINT "tenant_feature_flags_pk" PRIMARY KEY ("tenant_id", "flag")
);--> statement-breakpoint
ALTER TABLE "tenant_feature_flags" ADD CONSTRAINT "tenant_feature_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_feature_flags" ADD CONSTRAINT "tenant_feature_flags_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
