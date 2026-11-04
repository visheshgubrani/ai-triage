ALTER TABLE "documents" DROP CONSTRAINT "documents_processing_status_check";--> statement-breakpoint
ALTER TABLE "processing_runs" ADD COLUMN "skip_reason" text;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD COLUMN "intake_filters" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_processing_status_check" CHECK ("documents"."processing_status" in ('received', 'parsed', 'classified', 'extracted', 'done', 'failed', 'skipped'));--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_skip_reason_check" CHECK ("processing_runs"."skip_reason" in ('auto_replies', 'bounces', 'bulk'));