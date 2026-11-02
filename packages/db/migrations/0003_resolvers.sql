-- Hand-written: tenant lookups that run before a tenant context exists (docs/architecture.md §3).
-- A Postmark webhook names an inbound address, and a REST request carries an API key; both resolve to
-- a tenant through SECURITY DEFINER functions owned by the NOLOGIN role app_resolver. FORCE RLS binds
-- every role, so app_resolver gets its own SELECT-only policy on exactly these two tables. The app role
-- can execute the functions, but still can't read either table outside its tenant.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_resolver') THEN
    CREATE ROLE app_resolver NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO app_resolver;
GRANT SELECT ON public.inbound_addresses, public.api_keys TO app_resolver;
CREATE POLICY resolver_lookup ON public.inbound_addresses FOR SELECT TO app_resolver USING (true);
CREATE POLICY resolver_lookup ON public.api_keys FOR SELECT TO app_resolver USING (true);
--> statement-breakpoint

CREATE FUNCTION public.resolve_inbound_address(p_address text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT a.tenant_id FROM public.inbound_addresses a WHERE a.address = lower(p_address) $$;
--> statement-breakpoint

CREATE FUNCTION public.resolve_api_key(p_key_hash text) RETURNS TABLE (tenant_id uuid, key_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT k.tenant_id, k.id FROM public.api_keys k WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL $$;
--> statement-breakpoint

-- Migrations run as the compose superuser. A non-superuser owner would also need
-- `GRANT app_resolver TO <owner>` to hand over ownership, plus CREATE on schema public.
ALTER FUNCTION public.resolve_inbound_address(text) OWNER TO app_resolver;
ALTER FUNCTION public.resolve_api_key(text) OWNER TO app_resolver;
REVOKE ALL ON FUNCTION public.resolve_inbound_address(text), public.resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_inbound_address(text), public.resolve_api_key(text) TO app_rw;
