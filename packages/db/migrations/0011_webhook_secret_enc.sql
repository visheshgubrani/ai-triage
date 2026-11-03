ALTER TABLE "tenant_settings" ADD COLUMN "webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "webhook_secret_prev_enc" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "webhook_secret_prev_until" timestamp with time zone;