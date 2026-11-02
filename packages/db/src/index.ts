import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export * from "./auth";
export * from "./boss";
export * from "./budget";
export * from "./configs";
export * from "./documents";
export * from "./errors";
export * from "./llm-calls";
export * from "./pipeline";
export * from "./pipeline-config";
export * from "./prices";
export * from "./resolvers";
export * from "./roles";
export * from "./tenant-tx";
export * from "./tenants";
export * from "./users";
export { schema };

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
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
