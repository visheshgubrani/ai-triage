ALTER TABLE "document_parts" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "document_parts" ADD COLUMN "mime" text NOT NULL;--> statement-breakpoint
ALTER TABLE "document_parts" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "document_parts" ADD CONSTRAINT "document_parts_kind_check" CHECK ("document_parts"."kind" in ('email_body', 'attachment', 'file'));