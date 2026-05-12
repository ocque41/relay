ALTER TABLE "email_messages" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_providers" ADD COLUMN "verification_mode" text DEFAULT 'relay_confirm_link' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "inbox_alias" text;--> statement-breakpoint
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_inbox_alias_unique" UNIQUE("inbox_alias");