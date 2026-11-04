import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * from "./admission";
export * from "./audit";
export * from "./auth";
export * from "./boss";
export * from "./budget";
export * from "./configs";
export * from "./crypto";
export * from "./delivery";
export * from "./documents";
export * from "./errors";
export * from "./evals";
export * from "./health";
export * from "./heartbeats";
export * from "./llm-calls";
export * from "./mailboxes";
export * from "./members";
export * from "./metrics";
export * from "./pipeline";
export * from "./pipeline-config";
export * from "./prices";
export * from "./provider-state";
export * from "./purge";
export * from "./rate-limit";
export * from "./reconcile";
export * from "./resolvers";
export * from "./review";
export * from "./roles";
export * from "./runs";
export { MODEL_PRICE_SEED } from "./seed/prices";
export * from "./settings";
export * from "./startup";
export * from "./startup-checks";
export * from "./tenant-tx";
export * from "./tenants";
export * from "./uploads";
export * from "./users";
export { schema };

export type Pool = pg.Pool;

/**
 * A Postgres pool. `max` defaults to DB_POOL_MAX, else 10; a query waiting longer than 10 s for a
 * connection fails instead of queueing forever (a saturated pool shows up as errors, not a hang).
 */
export function createPool(connectionString = process.env.DATABASE_URL, options: { max?: number } = {}) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const max = options.max ?? (Number(process.env.DB_POOL_MAX) || 10);
  return new pg.Pool({ connectionString, max, connectionTimeoutMillis: 10_000 });
}

/**
 * Drizzle on the pool, outside any tenant context. RLS hides every tenant table here, so use it
 * only for global tables (auth, model_prices); tenant data goes through withTenantTx().
 */
export function createDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/** Cheap liveness probe for health checks. */
export async function pingDb(db: Db): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
