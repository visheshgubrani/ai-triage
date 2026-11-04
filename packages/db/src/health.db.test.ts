import { afterAll, describe, expect, it } from "vitest";
import { blockingProblems, deploymentHealth, tenantHealth } from "./health";
import { recordHeartbeat, removeHeartbeat } from "./heartbeats";
import { buildPipelineConfig, createDb, createPool, withTenantTx } from "./index";
import { newTenant, seedReviewTask, testDbUrls } from "./testing";

const app = createPool(testDbUrls().appUrl);
const db = createDb(app);
afterAll(() => app.end());

describe("System health", () => {
  it("summarizes one tenant's pipeline: statuses, open failures by reason, deliveries, budget", async () => {
    const tenantId = await newTenant(app);
    await withTenantTx(app, tenantId, async (tx) => {
      await buildPipelineConfig(tx);
      await seedReviewTask(tx, { kind: "processing_failed", reasons: ["provider_unavailable"] });
      await seedReviewTask(tx, { kind: "processing_failed", reasons: ["budget_exhausted"] });
      await seedReviewTask(tx);
    });
    const now = new Date();
    const health = await withTenantTx(app, tenantId, (tx) => tenantHealth(tx, now));
    expect(health.documents).toEqual(
      expect.arrayContaining([
        { status: "failed", count: 2, oldestUpdatedAt: null },
        { status: "done", count: 1, oldestUpdatedAt: null },
      ]),
    );
    expect(health.openFailures).toEqual(
      expect.arrayContaining([
        { reason: "provider_unavailable", count: 1 },
        { reason: "budget_exhausted", count: 1 },
      ]),
    );
    expect(health.delivery).toEqual({ pending: 0, failed: 0, oldestPendingAt: null });

    const blocking = await withTenantTx(app, tenantId, (tx) => blockingProblems(tx, db, now));
    expect(blocking.budgetWaiting).toBe(1);
  });

  it("counts running workers from their heartbeats", async () => {
    const now = new Date();
    const capabilities = { providers: [], simulator: false, recorded: [] };
    const worker = {
      workerId: "test-worker",
      hostname: "h",
      version: "0.7.0",
      llmMode: "replay",
      capabilities,
      startedAt: now,
    };
    await recordHeartbeat(db, worker, now);
    try {
      expect((await deploymentHealth(db, now)).workers).toContainEqual({
        version: "0.7.0",
        llmMode: "replay",
        lastSeenAt: now.toISOString(),
      });
    } finally {
      await removeHeartbeat(db, "test-worker");
    }
  });
});
