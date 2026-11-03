import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { auditDraw } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  createBoss,
  createPool,
  DEMO_CATEGORY_SETTINGS,
  DEMO_MODEL,
  getDocumentDetail,
  type PgBoss,
  setWebhook,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { type FixtureItem, loadManifest } from "@ai-triage/fixtures";
import { replayTransport } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { drainDeliveries } from "../delivery/drain";
import { verifyWebhook } from "../delivery/sign";
import { ingestFixture } from "../fixtures";
import { createDbLlmGateway } from "../llm";
import { drainTenantJobs } from "./drain";

// End to end in replay mode (docs/architecture.md §10): every fixture through ingestion and the
// real pipeline, with Claude's responses served from the committed cassettes. Runs once cassettes
// have been recorded (`LLM_MODE=record pnpm cassettes:record --yes` writes recorded.json); after
// that, a missing cassette fails the affected documents, and this test with them. Auto-approved
// documents are then delivered to an in-process receiver, as the worker would send them.

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
  const secret = "whsec_e2e";
  const delivered: { key: string; valid: boolean }[] = [];
  let receiver: Server;

  beforeAll(async () => {
    boss = createBoss(appUrl, { supervise: false, schedule: false });
    await boss.start();
    receiver = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => {
        body += c.toString("utf8");
      });
      req.on("end", () => {
        const signature = req.headers["x-triage-signature"];
        delivered.push({
          key: String(req.headers["idempotency-key"]),
          valid: verifyWebhook(secret, typeof signature === "string" ? signature : null, body, new Date()),
        });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    tenantId = await newTenant(pool);
    // The demo routing, without audit sampling (the audit branch is covered by unit tests).
    const categories = Object.fromEntries(
      Object.entries(DEMO_CATEGORY_SETTINGS).map(([k, v]) => [k, { ...v, auditRate: 0 }]),
    );
    await withTenantTx(pool, tenantId, async (tx) => {
      await buildPipelineConfig(tx, { classify: DEMO_MODEL, extract: DEMO_MODEL, categories });
      const { port } = receiver.address() as AddressInfo;
      await setWebhook(tx, { url: `http://127.0.0.1:${port}/hook`, secret });
    });
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
    await drainDeliveries({ pool, boss, fetch, now: () => new Date(), timeoutMs: 5000 }, tenantId);
  }, 300_000);
  afterAll(async () => {
    await new Promise((resolve) => receiver.close(resolve));
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

  // What a model decides varies by model; these assert what the system guarantees. Accuracy and
  // auto-approval precision per model are what the evals measure (phase 4).
  it.each([...clear("invoice"), ...clear("support_request")])(
    "%s (clear) is classified correctly, then either auto-approved and delivered, or sent to review with reasons",
    async (_id, item) => {
      const d = await detail(item);
      expect(d.classification?.category).toBe(item.expectedCategory);
      if (d.extraction?.decision === "auto") {
        expect(d.extraction.decisionReasons).toEqual([]);
        expect(d.actions).toHaveLength(1);
        expect(d.document.deliveryStatus).toBe("delivered");
      } else {
        expect(d.extraction?.decisionReasons.length).toBeGreaterThan(0);
        expect(d.task).toMatchObject({ kind: "review" });
        expect(d.actions).toEqual([]);
      }
    },
  );

  it("auto-approves at least half of the clear invoices and support requests", async () => {
    const all = [...clear("invoice"), ...clear("support_request")];
    let auto = 0;
    for (const [, item] of all) if ((await detail(item)).extraction?.decision === "auto") auto++;
    expect(auto / all.length).toBeGreaterThanOrEqual(0.5);
  });

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

  it.each(items((i) => i.tags.includes("ambiguous")))(
    "%s (ambiguous) is never auto-approved into a category other than its label",
    async (_id, item) => {
      const d = await detail(item);
      if (d.actions.length > 0) expect(d.classification?.category).toBe(item.expectedCategory);
      else expect(d.task?.kind).toMatch(/^(review|unclassified)$/);
    },
  );

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

  it("delivers every approved action exactly once, signed, keyed by the action id", async () => {
    const ids = await withTenantTx(pool, tenantId, async (tx) =>
      (await tx.queueDb.executeSql("select id, status from actions")).rows.map(
        (r) => r as { id: string; status: string },
      ),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((a) => a.status === "delivered")).toBe(true);
    expect(delivered.map((d) => d.key).sort()).toEqual(ids.map((a) => a.id).sort());
    expect(delivered.every((d) => d.valid)).toBe(true);
  });

  it("does nothing for a redelivered email", async () => {
    const item = manifest.items.find((i) => i.format === "postmark");
    if (!item) throw new Error("no email fixture");
    const again = await ingestFixture({ pool, boss, storage }, tenantId, item, config.fixturesDir, limits);
    expect(again).toEqual({ documentId: docs.get(item.id), duplicate: true });
  });
});
