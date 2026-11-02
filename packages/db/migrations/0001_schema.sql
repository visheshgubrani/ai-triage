CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_id_account_id_key" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"inviter_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_user_id_key" UNIQUE("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"active_organization_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_datasets_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "eval_datasets_name_key" UNIQUE("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "eval_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"source_mime" text,
	"expected_category" text NOT NULL,
	"expected_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"split" text NOT NULL,
	"origin" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_items_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "eval_items_split_check" CHECK ("eval_items"."split" in ('dev', 'calib', 'test')),
	CONSTRAINT "eval_items_origin_check" CHECK ("eval_items"."origin" in ('seed', 'import', 'review', 'label'))
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"eval_run_id" uuid NOT NULL,
	"eval_item_id" uuid NOT NULL,
	"predicted_category" text,
	"predicted_fields" jsonb,
	"field_scores" jsonb,
	"decision" text,
	"proposed_action" jsonb,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"classify_call_id" uuid,
	"extract_call_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_results_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "eval_results_run_item_key" UNIQUE("eval_run_id","eval_item_id"),
	CONSTRAINT "eval_results_decision_check" CHECK ("eval_results"."decision" in ('auto', 'review'))
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"dataset_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"split" text NOT NULL,
	"llm_mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"aggregates" jsonb,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "eval_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "eval_runs_split_check" CHECK ("eval_runs"."split" in ('dev', 'calib', 'test')),
	CONSTRAINT "eval_runs_llm_mode_check" CHECK ("eval_runs"."llm_mode" in ('live', 'replay')),
	CONSTRAINT "eval_runs_status_check" CHECK ("eval_runs"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"processing_run_id" uuid,
	"eval_run_id" uuid,
	"eval_item_id" uuid,
	"stage" text NOT NULL,
	"attempt" integer NOT NULL,
	"canonical" boolean DEFAULT false NOT NULL,
	"mode" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"request_hash" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"price_id" uuid,
	"latency_ms" integer,
	"stop_reason" text,
	"served_by_fallback" boolean DEFAULT false NOT NULL,
	"request_id" text,
	"response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "llm_calls_run_attempt_key" UNIQUE("processing_run_id","stage","attempt"),
	CONSTRAINT "llm_calls_eval_attempt_key" UNIQUE("eval_run_id","eval_item_id","stage","attempt"),
	CONSTRAINT "llm_calls_stage_check" CHECK ("llm_calls"."stage" in ('classify', 'extract')),
	CONSTRAINT "llm_calls_mode_check" CHECK ("llm_calls"."mode" in ('live', 'replay')),
	CONSTRAINT "llm_calls_one_context_check" CHECK (num_nonnulls("llm_calls"."processing_run_id", "llm_calls"."eval_run_id") = 1 and ("llm_calls"."eval_run_id" is null) = ("llm_calls"."eval_item_id" is null))
);
--> statement-breakpoint
CREATE TABLE "category_schema_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"category" text NOT NULL,
	"version" integer NOT NULL,
	"json_schema" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_schema_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "category_schema_versions_category_version_key" UNIQUE("tenant_id","category","version"),
	CONSTRAINT "category_schema_versions_tenant_id_id_category_key" UNIQUE("tenant_id","id","category")
);
--> statement-breakpoint
CREATE TABLE "classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"category" text NOT NULL,
	"self_confidence" numeric(4, 3) NOT NULL,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "classifications_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "classifications_run_id_key" UNIQUE("run_id"),
	CONSTRAINT "classifications_self_confidence_check" CHECK ("classifications"."self_confidence" >= 0 and "classifications"."self_confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "document_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"evidence_mode" text NOT NULL,
	"storage_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_parts_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "document_parts_document_id_part_index_key" UNIQUE("document_id","part_index"),
	CONSTRAINT "document_parts_evidence_mode_check" CHECK ("document_parts"."evidence_mode" in ('text', 'pdf_text', 'unverifiable'))
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"source_key" text NOT NULL,
	"title" text,
	"mime" text,
	"size_bytes" bigint,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"review_status" text DEFAULT 'not_required' NOT NULL,
	"delivery_status" text DEFAULT 'none' NOT NULL,
	"current_run_id" uuid,
	"current_extraction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "documents_source_external_id_key" UNIQUE("tenant_id","source","external_id"),
	CONSTRAINT "documents_source_check" CHECK ("documents"."source" in ('email', 'upload', 'api')),
	CONSTRAINT "documents_processing_status_check" CHECK ("documents"."processing_status" in ('received', 'parsed', 'classified', 'extracted', 'done', 'failed')),
	CONSTRAINT "documents_review_status_check" CHECK ("documents"."review_status" in ('not_required', 'pending', 'approved', 'rejected')),
	CONSTRAINT "documents_delivery_status_check" CHECK ("documents"."delivery_status" in ('none', 'pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"run_id" uuid,
	"revision" integer NOT NULL,
	"author" text NOT NULL,
	"parent_id" uuid,
	"category" text NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"fields" jsonb NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" numeric(4, 3),
	"decision" text,
	"decision_reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extractions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "extractions_tenant_id_document_id_id_key" UNIQUE("tenant_id","document_id","id"),
	CONSTRAINT "extractions_document_id_revision_key" UNIQUE("document_id","revision"),
	CONSTRAINT "extractions_author_check" CHECK ("extractions"."author" in ('model', 'user')),
	CONSTRAINT "extractions_decision_check" CHECK ("extractions"."decision" in ('auto', 'review')),
	CONSTRAINT "extractions_author_run_check" CHECK (("extractions"."author" = 'model') = ("extractions"."run_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "pipeline_config_categories" (
	"tenant_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"category" text NOT NULL,
	"schema_version_id" uuid NOT NULL,
	"threshold" numeric(4, 3) NOT NULL,
	"automation" text DEFAULT 'review_all' NOT NULL,
	"audit_rate" numeric(4, 3) DEFAULT 0.1 NOT NULL,
	CONSTRAINT "pipeline_config_categories_pkey" PRIMARY KEY("config_id","category"),
	CONSTRAINT "pipeline_config_categories_automation_check" CHECK ("pipeline_config_categories"."automation" in ('review_all', 'auto_when_confident')),
	CONSTRAINT "pipeline_config_categories_threshold_check" CHECK ("pipeline_config_categories"."threshold" >= 0 and "pipeline_config_categories"."threshold" <= 1),
	CONSTRAINT "pipeline_config_categories_audit_rate_check" CHECK ("pipeline_config_categories"."audit_rate" >= 0 and "pipeline_config_categories"."audit_rate" <= 1)
);
--> statement-breakpoint
CREATE TABLE "pipeline_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"classify_model" text NOT NULL,
	"classify_effort" text NOT NULL,
	"classify_prompt_version_id" uuid NOT NULL,
	"extract_model" text NOT NULL,
	"extract_effort" text NOT NULL,
	"extract_prompt_version_id" uuid NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_configs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "pipeline_configs_version_key" UNIQUE("tenant_id","version")
);
--> statement-breakpoint
CREATE TABLE "processing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"config_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"forced_category" text,
	"status" text DEFAULT 'running' NOT NULL,
	"superseded_by" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "processing_runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "processing_runs_tenant_id_document_id_id_key" UNIQUE("tenant_id","document_id","id"),
	CONSTRAINT "processing_runs_trigger_check" CHECK ("processing_runs"."trigger" in ('ingest', 'retry', 'reclassify')),
	CONSTRAINT "processing_runs_status_check" CHECK ("processing_runs"."status" in ('running', 'done', 'failed', 'superseded')),
	CONSTRAINT "processing_runs_forced_category_check" CHECK (("processing_runs"."trigger" = 'reclassify') = ("processing_runs"."forced_category" is not null))
);
--> statement-breakpoint
CREATE TABLE "prompt_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prompt_versions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prompt_versions_stage_version_key" UNIQUE("tenant_id","stage","version"),
	CONSTRAINT "prompt_versions_stage_check" CHECK ("prompt_versions"."stage" in ('classify', 'extract'))
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens_above" integer DEFAULT 0 NOT NULL,
	"input_per_mtok" numeric(10, 4) NOT NULL,
	"output_per_mtok" numeric(10, 4) NOT NULL,
	"cache_write_5m_per_mtok" numeric(10, 4) NOT NULL,
	"cache_write_1h_per_mtok" numeric(10, 4) NOT NULL,
	"cache_read_per_mtok" numeric(10, 4) NOT NULL,
	"batch_multiplier" numeric(4, 3) DEFAULT '0.5' NOT NULL,
	"effective_from" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_model_tier_effective_key" UNIQUE("model","prompt_tokens_above","effective_from")
);
--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "actions_extraction_id_key" UNIQUE("extraction_id"),
	CONSTRAINT "actions_status_check" CHECK ("actions"."status" in ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "review_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"review_task_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"diff" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_decisions_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "review_decisions_outcome_check" CHECK ("review_decisions"."outcome" in ('approve', 'edit_approve', 'reclassify', 'reject', 'retry'))
);
--> statement-breakpoint
CREATE TABLE "review_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"extraction_id" uuid,
	"reasons" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claimed_by" uuid,
	"claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "review_tasks_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "review_tasks_kind_check" CHECK ("review_tasks"."kind" in ('review', 'audit', 'processing_failed', 'unclassified')),
	CONSTRAINT "review_tasks_status_check" CHECK ("review_tasks"."status" in ('pending', 'claimed', 'awaiting_extraction', 'resolved')),
	CONSTRAINT "review_tasks_extraction_required_check" CHECK ("review_tasks"."kind" not in ('review', 'audit') or "review_tasks"."extraction_id" is not null),
	CONSTRAINT "review_tasks_claim_check" CHECK (("review_tasks"."status" = 'claimed') = ("review_tasks"."claim_token" is not null and "review_tasks"."claimed_by" is not null and "review_tasks"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash"),
	CONSTRAINT "api_keys_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "inbound_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"address" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inbound_addresses_address_unique" UNIQUE("address"),
	CONSTRAINT "inbound_addresses_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "inbound_addresses_lowercase_check" CHECK ("inbound_addresses"."address" = lower("inbound_addresses"."address"))
);
--> statement-breakpoint
CREATE TABLE "llm_budget_days" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"cap_usd" numeric(12, 4) NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"reserved_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	CONSTRAINT "llm_budget_days_pkey" PRIMARY KEY("tenant_id","day"),
	CONSTRAINT "llm_budget_days_non_negative_check" CHECK ("llm_budget_days"."cap_usd" >= 0 and "llm_budget_days"."spent_usd" >= 0 and "llm_budget_days"."reserved_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"active_config_id" uuid,
	"webhook_url" text,
	"webhook_secret" text,
	"daily_llm_cap_usd" numeric(12, 4) DEFAULT '5' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"expected_size" bigint NOT NULL,
	"expected_mime" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "uploads_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "logo" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "metadata" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_tenants_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_tenants_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_active_organization_id_tenants_id_fk" FOREIGN KEY ("active_organization_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_datasets" ADD CONSTRAINT "eval_datasets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_items" ADD CONSTRAINT "eval_items_dataset_fk" FOREIGN KEY ("tenant_id","dataset_id") REFERENCES "public"."eval_datasets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_fk" FOREIGN KEY ("tenant_id","eval_run_id") REFERENCES "public"."eval_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_item_fk" FOREIGN KEY ("tenant_id","eval_item_id") REFERENCES "public"."eval_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_classify_call_fk" FOREIGN KEY ("tenant_id","classify_call_id") REFERENCES "public"."llm_calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_extract_call_fk" FOREIGN KEY ("tenant_id","extract_call_id") REFERENCES "public"."llm_calls"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_dataset_fk" FOREIGN KEY ("tenant_id","dataset_id") REFERENCES "public"."eval_datasets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_runs" ADD CONSTRAINT "eval_runs_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "public"."pipeline_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_price_id_model_prices_id_fk" FOREIGN KEY ("price_id") REFERENCES "public"."model_prices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_processing_run_fk" FOREIGN KEY ("tenant_id","processing_run_id") REFERENCES "public"."processing_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_eval_run_fk" FOREIGN KEY ("tenant_id","eval_run_id") REFERENCES "public"."eval_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_eval_item_fk" FOREIGN KEY ("tenant_id","eval_item_id") REFERENCES "public"."eval_items"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD CONSTRAINT "category_schema_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classifications" ADD CONSTRAINT "classifications_run_fk" FOREIGN KEY ("tenant_id","document_id","run_id") REFERENCES "public"."processing_runs"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parts" ADD CONSTRAINT "document_parts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_parts" ADD CONSTRAINT "document_parts_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_run_fk" FOREIGN KEY ("tenant_id","id","current_run_id") REFERENCES "public"."processing_runs"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_current_extraction_fk" FOREIGN KEY ("tenant_id","id","current_extraction_id") REFERENCES "public"."extractions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_run_fk" FOREIGN KEY ("tenant_id","document_id","run_id") REFERENCES "public"."processing_runs"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_parent_fk" FOREIGN KEY ("tenant_id","document_id","parent_id") REFERENCES "public"."extractions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_schema_version_fk" FOREIGN KEY ("tenant_id","schema_version_id") REFERENCES "public"."category_schema_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_config_categories" ADD CONSTRAINT "pipeline_config_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_config_categories" ADD CONSTRAINT "pipeline_config_categories_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "public"."pipeline_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_config_categories" ADD CONSTRAINT "pipeline_config_categories_schema_fk" FOREIGN KEY ("tenant_id","schema_version_id","category") REFERENCES "public"."category_schema_versions"("tenant_id","id","category") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_parent_fk" FOREIGN KEY ("tenant_id","parent_id") REFERENCES "public"."pipeline_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_classify_prompt_fk" FOREIGN KEY ("tenant_id","classify_prompt_version_id") REFERENCES "public"."prompt_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_configs" ADD CONSTRAINT "pipeline_configs_extract_prompt_fk" FOREIGN KEY ("tenant_id","extract_prompt_version_id") REFERENCES "public"."prompt_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_config_fk" FOREIGN KEY ("tenant_id","config_id") REFERENCES "public"."pipeline_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_runs" ADD CONSTRAINT "processing_runs_superseded_by_fk" FOREIGN KEY ("tenant_id","document_id","superseded_by") REFERENCES "public"."processing_runs"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_versions" ADD CONSTRAINT "prompt_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_extraction_fk" FOREIGN KEY ("tenant_id","document_id","extraction_id") REFERENCES "public"."extractions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_task_fk" FOREIGN KEY ("tenant_id","review_task_id") REFERENCES "public"."review_tasks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_decisions" ADD CONSTRAINT "review_decisions_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_claimed_by_users_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_extraction_fk" FOREIGN KEY ("tenant_id","document_id","extraction_id") REFERENCES "public"."extractions"("tenant_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_addresses" ADD CONSTRAINT "inbound_addresses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_budget_days" ADD CONSTRAINT "llm_budget_days_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_active_config_fk" FOREIGN KEY ("tenant_id","active_config_id") REFERENCES "public"."pipeline_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_id_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "llm_calls_canonical_run_key" ON "llm_calls" USING btree ("processing_run_id","stage") WHERE "llm_calls"."canonical" and "llm_calls"."processing_run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "llm_calls_canonical_eval_key" ON "llm_calls" USING btree ("eval_run_id","eval_item_id","stage") WHERE "llm_calls"."canonical" and "llm_calls"."eval_run_id" is not null;--> statement-breakpoint
CREATE INDEX "documents_tenant_id_created_at_idx" ON "documents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_run_id_key" ON "extractions" USING btree ("run_id") WHERE "extractions"."run_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_tasks_one_open_per_document_key" ON "review_tasks" USING btree ("document_id") WHERE "review_tasks"."status" <> 'resolved';--> statement-breakpoint
CREATE INDEX "review_tasks_queue_idx" ON "review_tasks" USING btree ("tenant_id","status","created_at");