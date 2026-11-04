CREATE TABLE "installation" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"setup_token_hash" text,
	"setup_token_created_at" timestamp with time zone,
	"setup_completed_at" timestamp with time zone,
	"setup_tenant_id" uuid,
	CONSTRAINT "installation_single_row" CHECK ("installation"."id")
);
--> statement-breakpoint
ALTER TABLE "worker_heartbeats" ADD COLUMN "capabilities" jsonb DEFAULT '{"providers":[],"simulator":false,"recorded":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "onboarding_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "webhook_tested_at" timestamp with time zone;