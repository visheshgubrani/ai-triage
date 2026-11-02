import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "./index";
import { apiKeys } from "./schema";
import type { TenantTx } from "./tenant-tx";

// Lookups that run before a tenant context exists go through the SECURITY DEFINER functions in
// migrations/0003_resolvers.sql; everything after the lookup runs inside withTenantTx().

const KEY_FORMAT = /^tri_[0-9a-f]{8}_[A-Za-z0-9_-]{32}$/;

export const hashApiKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** The tenant that owns a Postmark inbound address, or null. */
export async function resolveInboundAddress(db: Db, address: string): Promise<string | null> {
  const { rows } = await db.execute<{ tenant_id: string | null }>(
    sql`select public.resolve_inbound_address(${address}) as tenant_id`,
  );
  return rows[0]?.tenant_id ?? null;
}

/** The tenant and key id of a live (unrevoked) API key, or null. */
export async function resolveApiKey(db: Db, key: string): Promise<{ tenantId: string; keyId: string } | null> {
  if (!KEY_FORMAT.test(key)) return null;
  const { rows } = await db.execute<{ tenant_id: string; key_id: string }>(
    sql`select tenant_id, key_id from public.resolve_api_key(${hashApiKey(key)})`,
  );
  const row = rows[0];
  return row ? { tenantId: row.tenant_id, keyId: row.key_id } : null;
}

/**
 * Creates an API key for the tenant in `tx`. Only its SHA-256 is stored, so the plaintext is
 * returned once. Format: `tri_<8 hex>_<32 base64url>`; the first part is the display prefix.
 */
export async function createApiKey(tx: TenantTx, input: { name: string; createdBy?: string }) {
  const prefix = `tri_${randomBytes(4).toString("hex")}`;
  const key = `${prefix}_${randomBytes(24).toString("base64url")}`;
  const [row] = await tx.db
    .insert(apiKeys)
    .values({ tenantId: tx.tenantId, name: input.name, prefix, keyHash: hashApiKey(key), createdBy: input.createdBy })
    .returning({ id: apiKeys.id });
  if (!row) throw new Error("api key insert returned no row");
  return { id: row.id, key, prefix };
}

export async function revokeApiKey(tx: TenantTx, keyId: string): Promise<boolean> {
  const rows = await tx.db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export async function touchApiKey(tx: TenantTx, keyId: string): Promise<void> {
  await tx.db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, keyId));
}
