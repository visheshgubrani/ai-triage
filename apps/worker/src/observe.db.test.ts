import { QUEUES } from "@ai-triage/core";
import { createBoss, createPool, sendTenantJob } from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { registry, sampleQueues } from "./observe";

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
afterAll(() => pool.end());

describe("queue sampler", () => {
  it("reads depth and the oldest waiting job per queue from pg-boss", async () => {
    const boss = createBoss(appUrl, { supervise: false, schedule: false });
    await boss.start();
    try {
      const tenantId = await newTenant(pool);
      await sendTenantJob(boss, tenantId, QUEUES.ping, { tenantId });
      await sampleQueues(pool);
      const text = registry.render();
      expect(text).toMatch(/triage_queue_jobs\{queue="system\.ping",state="created"\} \d+/);
      expect(text).toMatch(/triage_queue_oldest_seconds\{queue="system\.ping"\} \d+/);
      expect(text).toMatch(/triage_db_pool_connections\{state="total"\} \d+/);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
