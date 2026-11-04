import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { grantBossSchema, installBossSchema } from "./boss";
import { type KeyRing, keyRingFromEnv } from "./crypto";
import { createDb, createPool } from "./index";
import { APP_GROUP_ROLE, ensureAppRole } from "./roles";
import { seedPrices } from "./seed/prices";
import { encryptLegacyWebhookSecrets } from "./settings";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export interface MigrationUrls {
  /** Owner (the compose superuser): runs DDL and creates the app role. */
  ownerUrl: string;
  /** Runtime DATABASE_URL. Its user and password define the app login role. */
  appUrl: string;
}

/**
 * Everything `pnpm db:migrate` does, in order: ensure the app role exists, apply drizzle migrations
 * (schema, then 0002_rls grants and policies), install pg-boss and its queues, grant pgboss access,
 * seed model prices, encrypt legacy plaintext webhook secrets.
 * Idempotent. Also used by the test globalSetup against a scratch database.
 */
export async function runMigrations(
  { ownerUrl, appUrl }: MigrationUrls,
  keys: KeyRing = keyRingFromEnv(process.env),
): Promise<{ appRole: string }> {
  const pool = createPool(ownerUrl);
  try {
    const appRole = await ensureAppRole(pool, appUrl);
    await migrate(createDb(pool), { migrationsFolder });
    // The api and worker refuse to start while migrations are pending (startup-checks.ts), so the
    // app role reads the list of applied ones.
    await pool.query(`grant usage on schema drizzle to ${APP_GROUP_ROLE}`);
    await pool.query(`grant select on drizzle.__drizzle_migrations to ${APP_GROUP_ROLE}`);
    await installBossSchema(ownerUrl);
    await grantBossSchema(pool);
    // Reference data every instance needs (the demo seed is separate, and refused in production).
    await seedPrices(createDb(pool));
    // Data step: secrets stored in plaintext by older versions are encrypted (needs the key ring).
    await encryptLegacyWebhookSecrets(pool, keys);
    return { appRole };
  } finally {
    await pool.end();
  }
}
