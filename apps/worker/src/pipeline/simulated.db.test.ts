import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { normalizeEml } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  clearCooldown,
  createBoss,
  createDb,
  createPool,
  getDocumentDetail,
  type PgBoss,
  processSkipped,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { ingestEmail, ingestFile } from "@ai-triage/ingest";
import { createTransport } from "@ai-triage/llm";
import { DEFAULT_SIMULATOR_OPTIONS, type SimulatorOptions, simulate } from "@ai-triage/llm/testing";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { createDbLlmGateway } from "../llm";
import type { PipelineDeps } from "./deps";
import { drainTenantJobs } from "./drain";

// The pipeline end to end on the simulator (`sim:` models), in a worker whose LLM_MODE is replay:
// simulated calls still reach the simulator, are stored as `simulated`, cost nothing, and a 429
// storm turns into a shared cooldown, then provider_unavailable.

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const storage = createStorage(storageConfigFromEnv());
let boss: PgBoss;
let server: Server;
let options: SimulatorOptions = { ...DEFAULT_SIMULATOR_OPTIONS, latencyMs: 0, jitterMs: 0 };

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const answer = simulate(JSON.parse(Buffer.concat(chunks).toString("utf8")), options);
    res
      .writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
      .end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.LLM_SIMULATOR_URL = `http://localhost:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  delete process.env.LLM_SIMULATOR_URL;
  server.close();
  await clearCooldown(createDb(pool), "sim", "sim:simulated");
  await boss.stop({ graceful: false });
  await pool.end();
});

const INVOICE = `Invoice number: INV-${randomUUID().slice(0, 6)}
Invoice date: 2026-10-01
Vendor name: Northwind Supplies
Currency: EUR
Subtotal: 100.00
Tax: 20.00
Total: 120.00
Please pay this invoice by 2026-10-31.`;

async function setup() {
  const tenantId = await newTenant(pool);
  await withTenantTx(pool, tenantId, (tx) =>
    buildPipelineConfig(tx, {
      classify: { model: "sim:simulated", effort: "none" },
      extract: { model: "sim:simulated", effort: "none" },
    }),
  );
  const deps: PipelineDeps = {
    pool,
    boss,
    storage,
    llm: createDbLlmGateway({ pool, mode: "replay", transport: createTransport("replay", workerConfig().cassetteDir) }),
    limits: { maxPdfPages: 100 },
    auditDraw: () => 0.5,
    now: () => new Date(),
  };
  const ingest = async (text: string) =>
    (
      await ingestFile(
        { pool, boss, storage },
        tenantId,
        { bytes: new TextEncoder().encode(text), filename: "invoice.txt", mime: "text/plain", source: "api" },
        { maxFileBytes: 2 ** 20 },
      )
    ).documentId;
  const rows = <T>(sql: string) =>
    withTenantTx(pool, tenantId, async (tx) => (await tx.queueDb.executeSql(sql, [])).rows as T[]);
  const ingestEml = async (raw: string) =>
    (
      await ingestEmail({ pool, boss, storage }, tenantId, await normalizeEml(new TextEncoder().encode(raw)), {
        source: "email",
        eml: new TextEncoder().encode(raw),
      })
    ).documentId;
  return { tenantId, deps, ingest, ingestEml, rows, drain: () => drainTenantJobs(deps, tenantId) };
}

describe("simulated models", () => {
  it("run the pipeline in a replay-mode worker, stored as simulated calls that cost nothing", async () => {
    const t = await setup();
    const documentId = await t.ingest(INVOICE);
    await t.drain();
    const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(detail?.document.processingStatus).toBe("done");
    expect(detail?.classification?.category).toBe("invoice");
    expect(detail?.extraction?.fields).toMatchObject({ vendor_name: "Northwind Supplies", total: 120 });
    const calls = await t.rows<{ mode: string; cost_usd: string }>("select mode, cost_usd from llm_calls");
    expect(calls.map((c) => c.mode)).toEqual(["simulated", "simulated"]);
    expect(calls.every((c) => Number(c.cost_usd) === 0)).toBe(true);
  });

  it("turn a 429 storm into one shared cooldown, then provider_unavailable, calling no more than once", async () => {
    const t = await setup();
    options = { ...options, rate429: 1, retryAfterSeconds: 600 };
    try {
      const documentId = await t.ingest(INVOICE);
      await t.drain();
      const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
      expect(detail?.document.processingStatus).toBe("failed");
      expect(detail?.run?.error).toMatch(/^provider_unavailable/);
      // The first attempt reached the simulator; the retries found the cooldown and called nothing.
      const calls = await t.rows<{ error: string }>("select error from llm_calls");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.error).toMatch(/ProviderBusyError/);
    } finally {
      options = { ...options, rate429: 0 };
      await clearCooldown(createDb(pool), "sim", "sim:simulated");
    }
  });
});

describe("intake filters", () => {
  const autoReply = () =>
    [
      `Message-ID: <${randomUUID()}@example.com>`,
      "Auto-Submitted: auto-replied",
      "From: Accounts <accounts@vendor.test>",
      "To: ap@demo.test",
      "Subject: Out of office: Invoice INV-1",
      "",
      "I am out of the office until Monday.",
      "",
    ].join("\r\n");

  it("skip an auto-reply before any model call, and Process anyway runs it through", async () => {
    const t = await setup();
    const documentId = await t.ingestEml(autoReply());
    await t.drain();
    const skipped = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(skipped?.document).toMatchObject({ processingStatus: "skipped", reviewStatus: "not_required" });
    expect(skipped?.run).toMatchObject({ status: "done", skipReason: "auto_replies" });
    expect(await t.rows("select 1 from llm_calls")).toEqual([]);
    expect(await t.rows("select 1 from review_tasks")).toEqual([]);

    const runId = await withTenantTx(pool, t.tenantId, (tx) => processSkipped(tx, boss, documentId));
    expect(runId).toBeTruthy();
    // A second click finds it no longer skipped.
    expect(await withTenantTx(pool, t.tenantId, (tx) => processSkipped(tx, boss, documentId))).toBeNull();
    await t.drain();
    const processed = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(processed?.document.processingStatus).toBe("done");
    expect((await t.rows("select 1 from llm_calls")).length).toBeGreaterThan(0);
  });

  it("let bulk mail through unless the tenant turns that filter on", async () => {
    const t = await setup();
    const newsletter = autoReply().replace("Auto-Submitted: auto-replied", "List-Unsubscribe: <mailto:u@vendor.test>");
    const documentId = await t.ingestEml(newsletter);
    await t.drain();
    const doc = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(doc?.document.processingStatus).toBe("done");
  });
});
