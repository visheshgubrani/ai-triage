ALTER TABLE "eval_items" ALTER COLUMN "source_mime" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_items" ADD COLUMN "source_title" text;--> statement-breakpoint
ALTER TABLE "eval_items" ADD COLUMN "content_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_items" ADD COLUMN "origin_ref" text;--> statement-breakpoint
ALTER TABLE "eval_items" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "eval_items" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "score" numeric(4, 3);--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "reasons" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "gate_results" jsonb;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "category_correct" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "required_correct" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "fully_correct" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_results" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "item_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "eval_items_content_key" ON "eval_items" USING btree ("tenant_id","dataset_id","content_key") WHERE "eval_items"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "eval_items_split_idx" ON "eval_items" USING btree ("tenant_id","dataset_id","split") WHERE "eval_items"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "eval_runs_dataset_idx" ON "eval_runs" USING btree ("tenant_id","dataset_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_calls_created_idx" ON "llm_calls" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_error_reason_check" CHECK ("eval_results"."error_reason" in ('unsupported_file', 'file_too_large', 'too_many_pages', 'parse_error', 'request_too_large', 'llm_refusal', 'llm_truncated', 'llm_bad_request', 'invalid_output', 'cassette_missing', 'budget_exhausted', 'retries_exhausted'));--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_error_check" CHECK (("eval_results"."error" is null) = ("eval_results"."error_reason" is null));--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_score_check" CHECK ("eval_results"."score" >= 0 and "eval_results"."score" <= 1);--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_item_count_check" CHECK ("eval_runs"."item_count" > 0);