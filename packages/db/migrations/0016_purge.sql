-- Deleting a document (docs/security.md, M7: privacy). Extractions, actions and review decisions are
-- immutable for the app role (0006_review_guards.sql), and stay so. Deletion has one narrow door:
-- purge_document(), a SECURITY DEFINER function owned by the NOLOGIN role app_purger. Inside it
-- current_user is app_purger, which is the only role the guards let delete. RLS still applies (the
-- policies bind every role): the function works within the caller's tenant (app.tenant_id) only.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_purger') THEN
    CREATE ROLE app_purger NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_purger;
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON public.documents, public.document_parts, public.processing_runs,
  public.classifications, public.extractions, public.review_tasks, public.review_decisions,
  public.actions, public.llm_calls, public.uploads TO app_purger;
--> statement-breakpoint

-- The guards: unchanged for everyone else, a DELETE by app_purger passes.
CREATE OR REPLACE FUNCTION actions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_purger' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND to_jsonb(NEW) - ARRAY['status', 'attempts', 'last_error', 'delivered_at', 'updated_at']
       = to_jsonb(OLD) - ARRAY['status', 'attempts', 'last_error', 'delivered_at', 'updated_at'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'actions: only delivery columns may change (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION extractions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_purger' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.decision IS NULL
     AND to_jsonb(NEW) - ARRAY['gate_results', 'score', 'decision', 'decision_reasons']
       = to_jsonb(OLD) - ARRAY['gate_results', 'score', 'decision', 'decision_reasons'] THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'extractions are immutable; route may record a decision once (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint

CREATE FUNCTION review_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_purger' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'review_decisions rows are immutable (% rejected)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END $$;
--> statement-breakpoint
DROP TRIGGER review_decisions_immutable ON review_decisions;
--> statement-breakpoint
CREATE TRIGGER review_decisions_immutable BEFORE UPDATE OR DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION review_decisions_guard();
--> statement-breakpoint

-- Deletes one document and everything derived from it, children first (pointers on the document are
-- cleared first, since they reference its runs and extractions). Returns what storage still holds for
-- it, for the caller to delete after commit; no row if the document isn't visible in this tenant.
CREATE FUNCTION public.purge_document(p_document_id uuid)
  RETURNS TABLE (source_key text, source_mime text, part_keys text[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  t uuid := NULLIF(current_setting('app.tenant_id', true), '')::uuid;
  d public.documents%ROWTYPE;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'purge_document needs a tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO d FROM public.documents WHERE id = p_document_id AND tenant_id = t FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  part_keys := ARRAY(
    SELECT DISTINCT p.storage_key FROM public.document_parts p WHERE p.document_id = d.id AND p.storage_key IS NOT NULL
  );
  UPDATE public.documents SET current_run_id = NULL, current_extraction_id = NULL WHERE id = d.id;
  DELETE FROM public.actions WHERE document_id = d.id;
  DELETE FROM public.review_decisions WHERE document_id = d.id;
  DELETE FROM public.review_tasks WHERE document_id = d.id;
  DELETE FROM public.extractions WHERE document_id = d.id;
  DELETE FROM public.classifications WHERE document_id = d.id;
  DELETE FROM public.llm_calls WHERE processing_run_id IN (SELECT r.id FROM public.processing_runs r WHERE r.document_id = d.id);
  DELETE FROM public.processing_runs WHERE document_id = d.id;
  DELETE FROM public.document_parts WHERE document_id = d.id;
  DELETE FROM public.uploads WHERE storage_key = d.source_key;
  DELETE FROM public.documents WHERE id = d.id;
  source_key := d.source_key;
  source_mime := d.mime;
  RETURN NEXT;
END $$;
--> statement-breakpoint

-- Migrations run as the compose superuser (see 0003_resolvers.sql for a non-superuser owner).
ALTER FUNCTION public.purge_document(uuid) OWNER TO app_purger;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_document(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_document(uuid) TO app_rw;
