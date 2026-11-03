import { type KeyRing, keyRingFromEnv } from "../crypto";
import { createDb, createPool } from "../index";
import type { MigrationUrls } from "../migrate";
import { type DemoSeed, seedDemo, seedDemoWebhook, seedPipelineConfig } from "./demo";
import { seedPrices } from "./prices";

export { DEMO_PASSWORD, DEMO_TENANT, DEMO_USERS } from "./demo";
export { MODEL_PRICE_SEED, PRICES_VERIFIED_ON } from "./prices";

/**
 * `pnpm db:seed` (database part). Idempotent; run after `pnpm db:migrate`. Documents (and, in phase 4,
 * the eval dataset) need object storage and the ingestion package, so they are seeded by
 * apps/worker/src/bin/seed-documents.ts, which the root `db:seed` script runs next.
 */
export async function runSeed(
  { ownerUrl, appUrl }: MigrationUrls,
  options: { webhook?: { url: string; secret: string }; keys?: KeyRing } = {},
): Promise<DemoSeed> {
  const ownerPool = createPool(ownerUrl);
  const appPool = createPool(appUrl);
  try {
    await seedPrices(createDb(ownerPool));
    const demo = await seedDemo(appPool);
    await seedPipelineConfig(appPool, demo);
    if (options.webhook) {
      await seedDemoWebhook(appPool, demo, options.webhook, options.keys ?? keyRingFromEnv(process.env));
    }
    return demo;
  } finally {
    await Promise.all([ownerPool.end(), appPool.end()]);
  }
}
