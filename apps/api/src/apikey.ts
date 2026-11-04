import type { ErrorResponse } from "@ai-triage/contracts";
import type { ApiKeyScope } from "@ai-triage/core";
import { type Db, type Pool, resolveApiKey, touchApiKey, withTenantTx } from "@ai-triage/db";
import { createMiddleware } from "hono/factory";

export type ApiKeyEnv = { Variables: { apiKey: { tenantId: string; keyId: string; scopes: ApiKeyScope[] } } };

/**
 * Authenticates the public API with `Authorization: Bearer <tenant API key>`. The key resolves to
 * its tenant through a SECURITY DEFINER lookup (no tenant context exists yet); revoked keys fail.
 */
export const requireApiKey = (db: Db, pool: Pool) =>
  createMiddleware<ApiKeyEnv>(async (c, next) => {
    const key = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const resolved = key ? await resolveApiKey(db, key) : null;
    if (!resolved) return c.json({ error: "Invalid API key" }, 401);
    const scopes = await withTenantTx(pool, resolved.tenantId, (tx) => touchApiKey(tx, resolved.keyId));
    c.set("apiKey", { ...resolved, scopes });
    await next();
  });

/** 403 unless the key has `scope`. Keys made before scopes existed have only `ingest`. */
export const requireScope = (scope: ApiKeyScope) =>
  createMiddleware<ApiKeyEnv>(async (c, next) => {
    if (!c.var.apiKey.scopes.includes(scope)) {
      const body: ErrorResponse = {
        error: `This API key can't ${scope === "read" ? "read documents" : "send documents"}; create one with the ${scope} scope in Settings → API keys.`,
        code: "missing_scope",
      };
      return c.json(body, 403);
    }
    await next();
  });
