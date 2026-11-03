-- API keys may expire (docs/security.md, M6): the resolver, which runs before any tenant context,
-- refuses a key past its expires_at as it refuses a revoked one. CREATE OR REPLACE keeps the
-- function's owner (app_resolver) and grants from 0003_resolvers.sql.
CREATE OR REPLACE FUNCTION public.resolve_api_key(p_key_hash text) RETURNS TABLE (tenant_id uuid, key_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT k.tenant_id, k.id FROM public.api_keys k
  WHERE k.key_hash = p_key_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
$$;
