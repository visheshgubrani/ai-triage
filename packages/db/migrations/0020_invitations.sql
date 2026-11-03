ALTER TABLE "invitations" ALTER COLUMN "inviter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "token_hash" text;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "accept_with" text DEFAULT 'google' NOT NULL;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "invitations" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_token_hash_key" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_status_check" CHECK ("invitations"."status" in ('pending', 'accepted', 'revoked'));--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accept_with_check" CHECK ("invitations"."accept_with" in ('google', 'google_or_password'));