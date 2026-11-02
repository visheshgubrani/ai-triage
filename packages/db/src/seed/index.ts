import { createDb, createPool } from "../index";
import type { MigrationUrls } from "../migrate";
import { type DemoSeed, seedDemo, seedDocuments, seedEvalDataset, seedPipelineConfig } from "./demo";
import { seedPrices } from "./prices";

export { DEMO_PASSWORD, DEMO_TENANT, DEMO_USERS } from "./demo";
export { MODEL_PRICE_SEED, PRICES_VERIFIED_ON } from "./prices";

/** `pnpm db:seed`. Idempotent; run after `pnpm db:migrate`. */
export async function runSeed({ ownerUrl, appUrl }: MigrationUrls): Promise<DemoSeed> {
  const ownerPool = createPool(ownerUrl);
  const appPool = createPool(appUrl);
  try {
    await seedPrices(createDb(ownerPool));
    const demo = await seedDemo(appPool);
    await seedPipelineConfig(demo);
    await seedDocuments(demo);
    await seedEvalDataset(demo);
    return demo;
  } finally {
    await Promise.all([ownerPool.end(), appPool.end()]);
  }
}
