import { createBoss, createDb, createPool, findTenantBySlug } from "@ai-triage/db";
import { DEMO_TENANT } from "@ai-triage/db/seed";
import { loadManifest } from "@ai-triage/fixtures";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { workerConfig } from "../config";
import { seedEvalDemo } from "../eval-seed";

// `pnpm db:seed` (evals part): the demo tenant's labeled dataset and its first eval runs, which the
// worker then runs in replay. Idempotent.

const config = workerConfig();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const pool = createPool(databaseUrl);
const boss = createBoss(databaseUrl, { supervise: false, schedule: false });
await boss.start();
try {
  const demo = await findTenantBySlug(createDb(pool), DEMO_TENANT.slug);
  if (!demo) throw new Error("demo tenant not found: run `pnpm --filter @ai-triage/db seed` first");
  const result = await seedEvalDemo({
    pool,
    boss,
    storage: createStorage(storageConfigFromEnv()),
    tenantId: demo.id,
    manifest: await loadManifest(config.fixturesDir),
    fixturesDir: config.fixturesDir,
    cassetteDir: config.cassetteDir,
  });
  console.log(`eval dataset: ${result.itemsAdded} new items; ${result.runsQueued} eval runs queued for the worker`);
  for (const reason of result.skipped) console.log(`  skipped: ${reason}`);
} finally {
  await boss.stop({ graceful: true });
  await pool.end();
}
