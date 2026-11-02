import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { grantBossSchema, installBossSchema } from "./boss";
import { createDb, createPool } from "./index";
import { ensureAppRole } from "./roles";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrationUrls {
  /** Owner (the compose superuser): runs DDL and creates the app role. */
  ownerUrl: string;
  /** Runtime DATABASE_URL. Its user and password define the app login role. */
  appUrl: string;
}

/**
 * Everything `pnpm db:migrate` does, in order: ensure the app role exists, apply drizzle migrations
 * (schema, then 0002_rls grants and policies), install pg-boss and its queues, grant pgboss access.
 * Idempotent. Also used by the test globalSetup against a scratch database.
 */
export async function runMigrations({ ownerUrl, appUrl }: MigrationUrls): Promise<{ appRole: string }> {
  const pool = createPool(ownerUrl);
  try {
    const appRole = await ensureAppRole(pool, appUrl);
    await migrate(createDb(pool), { migrationsFolder });
    await installBossSchema(ownerUrl);
    await grantBossSchema(pool);
    return { appRole };
  } finally {
    await pool.end();
  }
}
