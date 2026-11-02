import { existsSync } from "node:fs";
import { join } from "node:path";
import { auditDraw } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  createBoss,
  createPool,
  DEMO_CATEGORY_SETTINGS,
  getDocumentDetail,
  type PgBoss,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { type FixtureItem, loadManifest } from "@ai-triage/fixtures";
import { replayTransport } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { ingestFixture } from "../fixtures";
import { createDbLlmGateway } from "../llm";
import { drainTenantJobs } from "./drain";

// End to end in replay mode (docs/architecture.md §10): every fixture through ingestion and the
// real pipeline, with Claude's responses served from the committed cassettes. Runs once cassettes
// have been recorded (`LLM_MODE=record pnpm cassettes:record --yes` writes recorded.json); after
// that, a missing cassette fails the affected documents, and this test with them.

const config = workerConfig();
const recorded = existsSync(join(config.cassetteDir, "recorded.json"));

describe.skipIf(!recorded)("pipeline end to end (replay)", async () => {
  const { appUrl } = testDbUrls();
  const pool = createPool(appUrl);
  const storage = createStorage(storageConfigFromEnv());
  const manifest = await loadManifest(config.fixturesDir);
  const limits = { maxFileBytes: config.maxFileBytes };
  let boss: PgBoss;
  let tenantId: string;
  const docs = new Map<string, string>();

  beforeAll(async () => {
    boss = createBoss(appUrl, { supervise: false, schedule: false });
    await boss.start();
    tenantId = await newTenant(pool);
    // The demo routing, without audit sampling (the audit branch is covered by unit tests).
    const categories = Object.fromEntries(
      Object.entries(DEMO_CATEGORY_SETTINGS).map(([k, v]) => [k, { ...v, auditRate: 0 }]),
    );
    await withTenantTx(pool, tenantId, (tx) => buildPipelineConfig(tx, { categories }));
    for (const item of manifest.items) {
      docs.set(
        item.id,
        (await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, limits)).documentId,
      );
    }
    await drainTenantJobs(
      {
        pool,
        boss,
        storage,
        llm: createDbLlmGateway({ pool, mode: "replay", transport: replayTransport(config.cassetteDir) }),
        limits: { maxPdfPages: config.maxPdfPages },
        auditDraw,
        now: () => new Date(),
      },
      tenantId,
    );
  }, 300_000);
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await pool.end();
  });

  const detail = async (item: FixtureItem) => {
    const d = await withTenantTx(pool, tenantId, (tx) => getDocumentDetail(tx, docs.get(item.id) ?? ""));
    if (!d) throw new Error(`no document for ${item.id}`);
    return d;
  };
  const items = (pred: (i: FixtureItem) => boolean) => manifest.items.filter(pred).map((i) => [i.id, i] as const);
  const clear = (category: string) => items((i) => i.tags.includes("clear") && i.expectedCategory === category);

  it.each(manifest.items.map((i) => [i.id, i] as const))(
    "%s is processed without a missing cassette",
    async (_id, item) => {
      const d = await detail(item);
      expect(d.run?.error ?? null).toBeNull();
      expect(d.document.processingStatus).toBe("done");
    },
  );

  it.each([...clear("invoice"), ...clear("support_request")])(
    "%s (clear) is classified correctly and auto-approved",
    async (_id, item) => {
      const d = await detail(item);
      expect(d.classification?.category).toBe(item.expectedCategory);
      expect(d.extraction?.decisionReasons).toEqual([]);
      expect(d.extraction?.decision).toBe("auto");
      expect(d.actions).toHaveLength(1);
      expect(d.document.deliveryStatus).toBe("pending");
    },
  );

  it.each(clear("contract"))(
    "%s (clear contract) goes to review: automation is off for contracts",
    async (_id, item) => {
      const d = await detail(item);
      expect(d.classification?.category).toBe("contract");
      expect(d.task).toMatchObject({ kind: "review" });
      expect(d.extraction?.decisionReasons).toContain("automation_off");
    },
  );

  it.each(clear("other"))("%s (other) becomes an unclassified task", async (_id, item) => {
    expect(await detail(item)).toMatchObject({ classification: { category: "other" }, task: { kind: "unclassified" } });
  });

  it.each(items((i) => i.tags.includes("ambiguous")))("%s (ambiguous) is not auto-approved", async (_id, item) => {
    const d = await detail(item);
    expect(d.actions).toEqual([]);
    expect(d.task?.kind).toMatch(/^(review|unclassified)$/);
  });

  it.each(items((i) => i.tags.includes("scan")))("%s (scan) goes to review as unverifiable", async (_id, item) => {
    const d = await detail(item);
    expect(d.actions).toEqual([]);
    expect(d.extraction?.decisionReasons).toContain("evidence_unverifiable");
  });

  it.each(items((i) => i.tags.includes("injection")))("%s (injection) is never auto-approved", async (_id, item) => {
    const d = await detail(item);
    expect(d.actions).toEqual([]);
    expect(d.extraction?.decision ?? "review").toBe("review");
  });

  it("labels every call as replayed, with one canonical call per run and stage, and run costs that add up", async () => {
    const rows = await withTenantTx(pool, tenantId, async (tx) => ({
      modes: (await tx.queueDb.executeSql("select distinct mode from llm_calls")).rows,
      dupes: (
        await tx.queueDb.executeSql(
          "select processing_run_id, stage from llm_calls where canonical group by 1, 2 having count(*) > 1",
        )
      ).rows,
      costs: (
        await tx.queueDb.executeSql(
          "select count(*)::int as calls, count(cost_usd)::int as priced, coalesce(sum(cost_usd), 0)::float as total from llm_calls",
        )
      ).rows[0] as { calls: number; priced: number; total: number },
    }));
    expect(rows.modes).toEqual([{ mode: "replay" }]);
    expect(rows.dupes).toEqual([]);
    expect(rows.costs.priced).toBe(rows.costs.calls);
    expect(rows.costs.total).toBeGreaterThan(0);
  });

  it("does nothing for a redelivered email", async () => {
    const item = manifest.items.find((i) => i.format === "postmark");
    if (!item) throw new Error("no email fixture");
    const again = await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, limits);
    expect(again).toEqual({ documentId: docs.get(item.id), duplicate: true });
  });
});
