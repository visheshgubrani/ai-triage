-- Hand-written: grants, row-level security and immutability triggers (docs/architecture.md §3).
-- `pnpm db:migrate` creates the login role named in DATABASE_URL as a member of app_rw before
-- running this, so the app never connects as the owner and RLS always applies to it.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- ── Grants ─────────────────────────────────────────────────────────────────────────────────
-- Explicit grants cover existing tables; default privileges cover tables later migrations create.
GRANT USAGE ON SCHEMA public TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
-- Prices are seeded by the owner and only read by the app.
REVOKE INSERT, UPDATE, DELETE ON model_prices FROM app_rw;
--> statement-breakpoint

-- ── Row-level security ─────────────────────────────────────────────────────────────────────
-- Every table with a tenant_id column. FORCE applies the policy to the table owner too.
-- NULLIF: once a SET LOCAL ends, a pooled session reports '' rather than NULL, and ''::uuid
-- would raise. With no tenant context, queries see no rows instead of erroring.
-- A test (rls.db.test.ts) fails if a tenant table is missing from this list.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_settings', 'inbound_addresses', 'api_keys', 'uploads', 'llm_budget_days',
    'category_schema_versions', 'prompt_versions', 'pipeline_configs', 'pipeline_config_categories',
    'documents', 'document_parts', 'processing_runs', 'classifications', 'extractions',
    'review_tasks', 'review_decisions', 'actions',
    'eval_datasets', 'eval_items', 'eval_runs', 'eval_results', 'llm_calls'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- ── Immutability ───────────────────────────────────────────────────────────────────────────
-- Versioned rows are never edited: a change is a new version (docs/architecture.md §4).

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER category_schema_versions_immutable BEFORE UPDATE OR DELETE ON category_schema_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE OR DELETE ON prompt_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER pipeline_config_categories_immutable BEFORE UPDATE OR DELETE ON pipeline_config_categories
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
--> statement-breakpoint

-- A config may only be frozen, once, with nothing else changing.
CREATE FUNCTION pipeline_configs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.frozen_at IS NULL AND NEW.frozen_at IS NOT NULL
     AND to_jsonb(NEW) - 'frozen_at' = to_jsonb(OLD) - 'frozen_at' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'pipeline_configs rows are immutable; only an unfrozen config can be frozen (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE TRIGGER pipeline_configs_immutable BEFORE UPDATE OR DELETE ON pipeline_configs
  FOR EACH ROW EXECUTE FUNCTION pipeline_configs_guard();
--> statement-breakpoint

-- A frozen config's category policy can't grow either.
CREATE FUNCTION pipeline_config_categories_frozen_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pipeline_configs WHERE id = NEW.config_id AND frozen_at IS NOT NULL) THEN
    RAISE EXCEPTION 'pipeline config % is frozen', NEW.config_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE TRIGGER pipeline_config_categories_frozen BEFORE INSERT ON pipeline_config_categories
  FOR EACH ROW EXECUTE FUNCTION pipeline_config_categories_frozen_guard();
