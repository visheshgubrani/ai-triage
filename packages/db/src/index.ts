import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export { schema };

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new pg.Pool({ connectionString });
}

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
