import { createBoss, createDb, createPool, findTenantBySlug } from "@ai-triage/db";
import { DEMO_TENANT } from "@ai-triage/db/seed";
import { loadManifest } from "@ai-triage/fixtures";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { workerConfig } from "../config";
import { ingestFixture } from "../fixtures";

// `pnpm db:seed` (documents part): ingests every fixture into the demo tenant. Idempotent: a
// document that already exists is a duplicate and nothing changes. The worker then processes the
// new ones (in replay mode, from the committed cassettes).

const config = workerConfig();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const pool = createPool(databaseUrl);
const boss = createBoss(databaseUrl, { supervise: false, schedule: false });
await boss.start();
try {
  const demo = await findTenantBySlug(createDb(pool), DEMO_TENANT.slug);
  if (!demo) throw new Error("demo tenant not found: run `pnpm --filter @ai-triage/db seed` first");
  const manifest = await loadManifest(config.fixturesDir);
  const deps = { pool, boss, storage: createStorage(storageConfigFromEnv()) };
  let created = 0;
  for (const item of manifest.items) {
    const { duplicate } = await ingestFixture(deps, demo.id, item, config.fixturesDir, {
      maxFileBytes: config.maxFileBytes,
    });
    if (!duplicate) created++;
  }
  console.log(
    `seeded ${created} new documents (${manifest.items.length - created} already present) into the demo tenant`,
  );
} finally {
  await boss.stop({ graceful: true });
  await pool.end();
}
