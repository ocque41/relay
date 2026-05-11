CREATE TABLE "cli_auth_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_code" text NOT NULL,
	"user_id" uuid,
	"agent_id" uuid,
	"agent_token_plaintext" text,
	"approved_at" timestamp with time zone,
	"picked_up_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "cli_auth_codes_device_code_unique" UNIQUE("device_code")
);
--> statement-breakpoint
ALTER TABLE "cli_auth_codes" ADD CONSTRAINT "cli_auth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_auth_codes" ADD CONSTRAINT "cli_auth_codes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;