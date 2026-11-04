import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { normalizeEml } from "@ai-triage/core/pipeline";
import {
  activateConfig,
  buildPipelineConfig,
  clearCooldown,
  createBoss,
  createCandidateConfig,
  createCategoryVersion,
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
import { STARTERS } from "@ai-triage/schemas";
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
/** Every request body the simulator received, newest last. */
const received: { messages?: { role: string; content: unknown }[] }[] = [];

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push(body);
    const answer = simulate(body, options);
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

/** A fake OCR server (llama.cpp's OpenAI-compatible API): one answer for every page, or a status. */
let ocrAnswer: { status: number; text: string } = { status: 200, text: "" };
let ocrServer: Server;
let ocrUrl = "";
beforeAll(async () => {
  ocrServer = createServer((_req, res) => {
    res.writeHead(ocrAnswer.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: ocrAnswer.text } }] }));
  });
  await new Promise<void>((resolve) => ocrServer.listen(0, resolve));
  ocrUrl = `http://localhost:${(ocrServer.address() as AddressInfo).port}/v1`;
});
afterAll(() => ocrServer.close());

async function setup(options: { ocr?: boolean } = {}) {
  const tenantId = await newTenant(pool);
  const config = await withTenantTx(pool, tenantId, (tx) =>
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
    limits: {
      maxPdfPages: 100,
      // The real sandbox, so page images come out of the thread the worker uses.
      sandbox: { timeoutMs: 30_000, maxMemoryMb: 256 },
      ocr: options.ocr ? { url: ocrUrl, timeoutMs: 5000, maxPages: 20 } : null,
    },
    auditDraw: () => 0.5,
    now: () => new Date(),
  };
  const ingest = async (text: string | Uint8Array, filename = "invoice.txt", mime = "text/plain") =>
    (
      await ingestFile(
        { pool, boss, storage },
        tenantId,
        {
          bytes: typeof text === "string" ? new TextEncoder().encode(text) : text,
          filename,
          mime,
          source: "api",
        },
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
  return { tenantId, configId: config.id, deps, ingest, ingestEml, rows, drain: () => drainTenantJobs(deps, tenantId) };
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

describe("custom categories", () => {
  const purchaseOrder = STARTERS.find((s) => s.id === "purchase_order")?.definition;
  const PO = `PURCHASE ORDER
PO number: PO-${randomUUID().slice(0, 6)}
Buyer name: Contoso Retail
Supplier name: Northwind Supplies
Order date: 2026-10-02
Please supply 200 units of part A-17 against this purchase order.`;

  it("classify into a tenant's category with prompt v2, extract its fields in order, and go to review", async () => {
    if (!purchaseOrder) throw new Error("purchase_order starter missing");
    const t = await setup();
    await withTenantTx(pool, t.tenantId, async (tx) => {
      const version = await createCategoryVersion(tx, purchaseOrder);
      const created = await createCandidateConfig(tx, {
        parentId: t.configId,
        name: "with purchase orders",
        schemaVersions: { purchase_order: version.id },
      });
      await activateConfig(tx, created.id);
    });
    const documentId = await t.ingest(PO);
    await t.drain();
    const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(detail?.document.processingStatus).toBe("done");
    expect(detail?.classification?.category).toBe("purchase_order");
    expect(detail?.extraction?.fields).toMatchObject({ buyer_name: "Contoso Retail" });
    // The page shows fields in the definition's order, which jsonb alone wouldn't keep.
    const shown = Object.keys(((detail?.schema ?? {}) as { properties?: object }).properties ?? {});
    expect(shown).toEqual(purchaseOrder.fields.map((f) => f.name));
    // Every category is on review_all after a category change, so a person sees it.
    expect(detail?.task?.status).toBe("pending");
    // The classify request used v2: the definition's examples, and none of v1's built-in ones.
    const system = received
      .map((r) => r.messages?.find((m) => m.role === "system")?.content)
      .filter((c): c is string => typeof c === "string")
      .findLast((c) => c.includes("- purchase_order: "));
    expect(system).toContain("Answer: purchase_order");
    expect(system).not.toContain("Answer: invoice");
  });
});

describe("optional OCR", () => {
  const scan = () => new Uint8Array(readFileSync(join(workerConfig().fixturesDir, "docs/scan-inv.pdf")));
  const SCAN_TEXT = `Kestrel Logistics GmbH
INVOICE
Invoice No.: KL-2857
Invoice date: May 27, 2026
Vendor name: Kestrel Logistics GmbH
Subtotal: 10648.99
Total due: 10648.99 USD`;

  it("reads a scanned PDF, so its quotes are checked against the OCR'd text", async () => {
    const t = await setup({ ocr: true });
    ocrAnswer = { status: 200, text: SCAN_TEXT };
    const documentId = await t.ingest(scan(), "scan-inv.pdf", "application/pdf");
    await t.drain();
    const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(detail?.document.processingStatus).toBe("done");
    expect(detail?.parts.map((p) => [p.evidenceMode, p.text.includes("KL-2857")])).toEqual([["ocr_text", true]]);
    expect(detail?.classification?.category).toBe("invoice");
    // No longer unverifiable: the gate checked the quotes against the OCR'd page.
    const reasons = detail?.task?.reasons ?? detail?.extraction?.decisionReasons ?? [];
    expect(reasons).not.toContain("evidence_unverifiable");
  });

  // The simulator reads no PDFs or images, like any text-only model: OCR is what lets it read a scan.
  it("falls back to no OCR when OCR fails: the scan stays unverifiable, as with OCR off", async () => {
    const t = await setup({ ocr: true });
    ocrAnswer = { status: 503, text: "" };
    try {
      const documentId = await t.ingest(scan(), "scan-inv.pdf", "application/pdf");
      await t.drain();
      const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
      expect(detail?.parts.map((p) => p.evidenceMode)).toEqual(["unverifiable"]);
      // Parsing succeeded; the text-only model then can't read the scan, exactly as without OCR.
      expect(detail?.run?.error).toMatch(/^unsupported_file/);
    } finally {
      ocrAnswer = { status: 200, text: "" };
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
