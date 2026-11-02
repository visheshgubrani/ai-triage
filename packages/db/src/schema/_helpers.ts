import { type SQL, sql } from "drizzle-orm";
import { check, type PgColumn, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./auth";

// Column and constraint helpers shared by every tenant table. The tenant-isolation rules
// (docs/architecture.md §3) are encoded here once: every tenant table has `tenant_id`, every
// parent exposes `unique (tenant_id, id)`, and children reference parents through composite
// foreign keys that include `tenant_id`, so a cross-tenant reference fails in the database.

export const pk = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** `tenant_id` column. Its presence is what marks a table for RLS (see migrations/0002_rls.sql). */
export const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id);

/** `unique (tenant_id, id)`: the target of composite foreign keys from child tables. */
export const tenantKey = (table: string, t: { tenantId: PgColumn; id: PgColumn }) =>
  unique(`${table}_tenant_id_id_key`).on(t.tenantId, t.id);

/**
 * CHECK that a text column holds one of a closed set (the `as const` arrays in @ai-triage/core).
 * Text + CHECK instead of pgEnum: drizzle runs pending migrations in one transaction, and a value
 * added with ALTER TYPE ... ADD VALUE can't be used in the same transaction.
 * The values are inlined with sql.raw because JS values inside check() become bind parameters.
 */
export const oneOf = (name: string, column: PgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(values.map(quote).join(", "))})`);

export const between01 = (name: string, column: PgColumn): ReturnType<typeof check> =>
  check(name, sql`${column} >= 0 and ${column} <= 1`);

export const emptyTextArray = (): SQL => sql`'{}'::text[]`;

function quote(value: string): string {
  if (!/^[a-z0-9_.-]+$/.test(value)) throw new Error(`Unsafe enum value: ${value}`);
  return `'${value}'`;
}
