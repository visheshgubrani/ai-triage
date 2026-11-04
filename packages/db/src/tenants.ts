import { randomBytes, randomUUID } from "node:crypto";
import { isOneOf, MEMBER_ROLES, type MemberRole } from "@ai-triage/core";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type * as schema from "./schema";
import { inboundAddresses, memberships, tenantSettings, tenants } from "./schema";
import { type TenantTx, withTenantTx } from "./tenant-tx";

export interface NewTenant {
  name: string;
  slug: string;
  /** Postmark inbound address that routes to this tenant. */
  inboundAddress?: string;
  /** Without an explicit address: generate an unguessable one at this domain. */
  inboundDomain?: string;
}

/**
 * An inbound address nobody can guess (80 random bits): anyone who knows a tenant's address can
 * put mail into its pipeline and spend its budget, so it shouldn't be derivable from the tenant.
 */
export const generateInboundAddress = (domain: string) =>
  `t-${randomBytes(10).toString("hex")}@${domain.toLowerCase()}`;

/**
 * Creates a tenant with its settings (and optional inbound address) in one transaction.
 * The only way tenants are created: Better Auth's own organization creation is disabled.
 */
export async function createTenant(pool: pg.Pool, input: NewTenant): Promise<{ id: string }> {
  const id = randomUUID();
  return withTenantTx(pool, id, async ({ db }) => {
    await db.insert(tenants).values({ id, name: input.name, slug: input.slug });
    await db.insert(tenantSettings).values({ tenantId: id });
    const address = input.inboundAddress ?? (input.inboundDomain ? generateInboundAddress(input.inboundDomain) : null);
    if (address) await db.insert(inboundAddresses).values({ tenantId: id, address: address.toLowerCase() });
    return { id };
  });
}

/**
 * The membership of `userId` in `tenantId`, or null. Memberships are global (no RLS), so every
 * read filters on both ids here instead of at call sites.
 */
export async function getMembership(
  db: NodePgDatabase<typeof schema>,
  userId: string,
  tenantId: string,
): Promise<{ role: MemberRole } | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.organizationId, tenantId)))
    .limit(1);
  return row && isOneOf(MEMBER_ROLES, row.role) ? { role: row.role } : null;
}

export async function getTenant(db: NodePgDatabase<typeof schema>, tenantId: string) {
  const [row] = await db
    .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row ?? null;
}

/** Every tenant, for operator tooling (preflight). Tenants are a global table. */
export async function listTenants(db: NodePgDatabase<typeof schema>) {
  return db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug }).from(tenants).orderBy(tenants.slug);
}

export async function findTenantBySlug(db: NodePgDatabase<typeof schema>, slug: string) {
  const [row] = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return row ?? null;
}

/** The tenant's inbound addresses (normally one). */
export async function listInboundAddresses(tx: TenantTx): Promise<string[]> {
  const rows = await tx.db.select({ address: inboundAddresses.address }).from(inboundAddresses);
  return rows.map((r) => r.address);
}

/**
 * Replaces the tenant's inbound addresses with a new unguessable one at `domain` (by default the
 * domain of the current address). Mail to the old address is ignored from now on.
 */
export async function rotateInboundAddress(tx: TenantTx, domain?: string): Promise<{ from: string[]; to: string }> {
  const from = await listInboundAddresses(tx);
  const at = domain ?? from[0]?.split("@")[1];
  if (!at) throw new Error("no inbound domain: set INBOUND_DOMAIN");
  const to = generateInboundAddress(at);
  await tx.db.delete(inboundAddresses);
  await tx.db.insert(inboundAddresses).values({ tenantId: tx.tenantId, address: to });
  return { from, to };
}

/**
 * Offboarding (docs/security.md, M7): deletes every row of a tenant, its memberships and the tenant
 * itself, plus its queued jobs, in one transaction on the OWNER pool. Immutability guards and FKs
 * are switched off for the transaction (session_replication_role = replica, which needs a superuser:
 * the compose owner is one). Users stay: they're global and may belong to other tenants. Storage is
 * the caller's job (everything under `t/{tenantId}/`).
 */
export async function deleteTenantData(ownerPool: pg.Pool, tenantId: string): Promise<Record<string, number>> {
  const client = await ownerPool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = replica");
    const { rows: tables } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'tenant_id' and table_name <> 'tenants'`,
    );
    for (const { table_name } of tables) {
      const res = await client.query(`delete from public.${pgIdent(table_name)} where tenant_id = $1`, [tenantId]);
      if (res.rowCount) counts[table_name] = res.rowCount;
    }
    for (const table of ["memberships", "invitations"]) {
      const res = await client.query(`delete from public.${table} where organization_id = $1`, [tenantId]);
      if (res.rowCount) counts[table] = res.rowCount;
    }
    await client.query("update public.sessions set active_organization_id = null where active_organization_id = $1", [
      tenantId,
    ]);
    const jobs = await client.query("delete from pgboss.job where data->>'tenantId' = $1", [tenantId]);
    if (jobs.rowCount) counts["pgboss.job"] = jobs.rowCount;
    await client.query("delete from public.tenants where id = $1", [tenantId]);
    await client.query("COMMIT");
    return counts;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const pgIdent = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected table name ${name}`);
  return `"${name}"`;
};
