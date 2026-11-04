-- The reconciler (docs/architecture.md §5, self-healing) runs before any tenant is known, so it lists
-- candidate stale work through a SECURITY DEFINER resolver (the pattern of 0023_mailbox_sync.sql):
-- kinds, tenant ids and row ids only. The app role then checks each one against pgboss.job inside
-- the tenant's transaction, and fails only what no job will ever pick up again.
GRANT SELECT ON public.documents, public.actions, public.eval_runs TO app_resolver;
--> statement-breakpoint
CREATE POLICY resolver_lookup ON public.documents FOR SELECT TO app_resolver USING (true);
--> statement-breakpoint
CREATE POLICY resolver_lookup ON public.actions FOR SELECT TO app_resolver USING (true);
--> statement-breakpoint
CREATE POLICY resolver_lookup ON public.eval_runs FOR SELECT TO app_resolver USING (true);
--> statement-breakpoint
CREATE FUNCTION public.stale_work(p_before timestamptz, p_limit integer)
  RETURNS TABLE (kind text, tenant_id uuid, id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  (SELECT 'document', d.tenant_id, d.id FROM public.documents d
    WHERE d.processing_status IN ('received', 'parsed', 'classified', 'extracted') AND d.updated_at < p_before
    ORDER BY d.updated_at LIMIT p_limit)
  UNION ALL
  (SELECT 'action', a.tenant_id, a.id FROM public.actions a
    WHERE a.status = 'pending' AND a.updated_at < p_before
    ORDER BY a.updated_at LIMIT p_limit)
  UNION ALL
  (SELECT 'eval_run', r.tenant_id, r.id FROM public.eval_runs r
    WHERE r.status IN ('queued', 'running') AND r.created_at < p_before
    ORDER BY r.created_at LIMIT p_limit)
$$;
--> statement-breakpoint
ALTER FUNCTION public.stale_work(timestamptz, integer) OWNER TO app_resolver;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.stale_work(timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.stale_work(timestamptz, integer) TO app_rw;
