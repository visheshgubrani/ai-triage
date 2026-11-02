import { type Db, type Pool, resolveApiKey, touchApiKey, withTenantTx } from "@ai-triage/db";
import { createMiddleware } from "hono/factory";

export type ApiKeyEnv = { Variables: { apiKey: { tenantId: string; keyId: string } } };

/**
 * Authenticates the public API with `Authorization: Bearer <tenant API key>`. The key resolves to
 * its tenant through a SECURITY DEFINER lookup (no tenant context exists yet); revoked keys fail.
 */
export const requireApiKey = (db: Db, pool: Pool) =>
  createMiddleware<ApiKeyEnv>(async (c, next) => {
    const key = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const resolved = key ? await resolveApiKey(db, key) : null;
    if (!resolved) return c.json({ error: "Invalid API key" }, 401);
    await withTenantTx(pool, resolved.tenantId, (tx) => touchApiKey(tx, resolved.keyId));
    c.set("apiKey", resolved);
    await next();
  });
