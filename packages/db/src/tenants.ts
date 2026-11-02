import { randomUUID } from "node:crypto";
import { isOneOf, MEMBER_ROLES, type MemberRole } from "@ai-triage/core";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import type * as schema from "./schema";
import { inboundAddresses, memberships, tenantSettings, tenants } from "./schema";
import { withTenantTx } from "./tenant-tx";

export interface NewTenant {
  name: string;
  slug: string;
  /** Postmark inbound address that routes to this tenant. */
  inboundAddress?: string;
}

/**
 * Creates a tenant with its settings (and optional inbound address) in one transaction.
 * The only way tenants are created: Better Auth's own organization creation is disabled.
 */
export async function createTenant(pool: pg.Pool, input: NewTenant): Promise<{ id: string }> {
  const id = randomUUID();
  return withTenantTx(pool, id, async ({ db }) => {
    await db.insert(tenants).values({ id, name: input.name, slug: input.slug });
    await db.insert(tenantSettings).values({ tenantId: id });
    if (input.inboundAddress) {
      await db.insert(inboundAddresses).values({ tenantId: id, address: input.inboundAddress.toLowerCase() });
    }
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
