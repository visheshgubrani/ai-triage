ALTER TABLE "review_tasks" DROP CONSTRAINT "review_tasks_claim_check";--> statement-breakpoint
ALTER TABLE "review_decisions" ADD COLUMN "task_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD COLUMN "extraction_id" uuid;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_extraction_fk" FOREIGN KEY ("tenant_id","document_id","extraction_id") REFERENCES "public"."extractions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_status_idx" ON "actions" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "review_decisions_document_idx" ON "review_decisions" USING btree ("tenant_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "review_tasks_lease_idx" ON "review_tasks" USING btree ("tenant_id","lease_expires_at");--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_user_author_check" CHECK ("extractions"."author" <> 'user' or "extractions"."created_by" is not null);--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_task_kind_check" CHECK ("review_decisions"."task_kind" in ('review', 'audit', 'processing_failed', 'unclassified'));--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_claim_check" CHECK (("review_tasks"."status" = 'claimed') = ("review_tasks"."claim_token" is not null) and ("review_tasks"."claim_token" is null) = ("review_tasks"."claimed_by" is null) and ("review_tasks"."claim_token" is null) = ("review_tasks"."lease_expires_at" is null));