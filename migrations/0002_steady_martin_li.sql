CREATE TABLE "signup_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signup_job_id" uuid NOT NULL,
	"token" text NOT NULL,
	"email" text NOT NULL,
	"tenant_provider_slug" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "signup_confirmations_signup_job_id_unique" UNIQUE("signup_job_id"),
	CONSTRAINT "signup_confirmations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "signup_confirmations" ADD CONSTRAINT "signup_confirmations_signup_job_id_signup_jobs_id_fk" FOREIGN KEY ("signup_job_id") REFERENCES "public"."signup_jobs"("id") ON DELETE cascade ON UPDATE no action;