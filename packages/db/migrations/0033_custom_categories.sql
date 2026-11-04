ALTER TABLE "category_schema_versions" ADD COLUMN "definition" jsonb;--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD COLUMN "origin" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD CONSTRAINT "category_schema_versions_origin_check" CHECK ("category_schema_versions"."origin" in ('builtin', 'custom'));--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD CONSTRAINT "category_schema_versions_custom_name_check" CHECK ("category_schema_versions"."definition" is null or "category_schema_versions"."category" not in ('invoice', 'support_request', 'contract', 'other'));--> statement-breakpoint
ALTER TABLE "category_schema_versions" ADD CONSTRAINT "category_schema_versions_definition_check" CHECK (("category_schema_versions"."definition" is null) = ("category_schema_versions"."origin" = 'builtin'));