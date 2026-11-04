ALTER TABLE "documents" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "scopes" text[] DEFAULT '{ingest}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "documents_external_ref_idx" ON "documents" USING btree ("tenant_id","external_ref") WHERE "documents"."external_ref" is not null;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_external_ref_check" CHECK (char_length("documents"."external_ref") <= 200);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_scopes_check" CHECK (cardinality("api_keys"."scopes") > 0 and "api_keys"."scopes" <@ array['ingest', 'read']::text[]);