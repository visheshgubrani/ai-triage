-- Mailbox sync (docs/architecture.md §5). The cron poll runs before any tenant is known, so it lists
-- the mailboxes that are due through a SECURITY DEFINER resolver (the pattern of 0003_resolvers.sql):
-- tenant and connection ids only, nothing else about them.
GRANT SELECT ON public.mailbox_connections TO app_resolver;
--> statement-breakpoint
CREATE POLICY resolver_lookup ON public.mailbox_connections FOR SELECT TO app_resolver USING (true);
--> statement-breakpoint
CREATE FUNCTION public.due_mailbox_connections(p_now timestamptz) RETURNS TABLE (tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT c.tenant_id, c.id FROM public.mailbox_connections c
  WHERE c.status = 'active' AND c.next_sync_at <= p_now
  ORDER BY c.next_sync_at
$$;
--> statement-breakpoint
ALTER FUNCTION public.due_mailbox_connections(timestamptz) OWNER TO app_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.due_mailbox_connections(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.due_mailbox_connections(timestamptz) TO app_rw;
--> statement-breakpoint

-- purge_document() (0016_purge.sql) also turns the document's ledger row into a tombstone.
GRANT SELECT, UPDATE ON public.mailbox_messages TO app_purger;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.purge_document(p_document_id uuid)
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
  -- The synced message stays in the ledger as a tombstone, so a resync doesn't ingest it again.
  UPDATE public.mailbox_messages SET document_id = NULL, status = 'purged', updated_at = now() WHERE document_id = d.id;
  DELETE FROM public.documents WHERE id = d.id;
  source_key := d.source_key;
  source_mime := d.mime;
  RETURN NEXT;
END $$;
