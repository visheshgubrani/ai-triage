import {
  buildPipelineConfig,
  createBoss,
  createPool,
  listAuditEvents,
  listDocuments,
  type PgBoss,
  setRetentionDays,
  setReviewOutcome,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, seedReviewTask, testDbUrls } from "@ai-triage/db/testing";
import type { Storage } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepRetention } from "./register";

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
let boss: PgBoss;
beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

describe("sweepRetention", () => {
  it("purges finished documents past the tenant's retention and records one audit event", async () => {
    const tenantId = await newTenant(pool);
    const { finished, open } = await withTenantTx(pool, tenantId, async (tx) => {
      await buildPipelineConfig(tx);
      const finished = (await seedReviewTask(tx)).documentId;
      await setReviewOutcome(tx, finished, { reviewStatus: "rejected" });
      const open = (await seedReviewTask(tx)).documentId;
      await setRetentionDays(tx, 1);
      return { finished, open };
    });
    const twoDaysOn = new Date(Date.now() + 2 * 86_400_000);
    const purged = await sweepRetention({ pool, boss, storage: {} as Storage, now: () => twoDaysOn }, tenantId);
    expect(purged).toBe(1);
    const left = await withTenantTx(pool, tenantId, (tx) => listDocuments(tx, { limit: 10 }));
    expect(left.map((d) => d.id)).toEqual([open]);
    expect(left.map((d) => d.id)).not.toContain(finished);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 1 }));
    expect(events[0]).toMatchObject({ action: "retention.swept", actorType: "system", details: { purged: 1 } });
  });
});
