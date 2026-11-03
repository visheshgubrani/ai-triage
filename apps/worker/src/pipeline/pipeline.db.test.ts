import { randomUUID } from "node:crypto";
import { type Effort, type ModelRef, QUEUES, type StageJob } from "@ai-triage/core";
import {
  buildPipelineConfig,
  createBoss,
  createPool,
  getDocumentDetail,
  type PgBoss,
  startRun,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { ingestEmail, ingestFile } from "@ai-triage/ingest";
import type { GatewayHooks } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbLlmGateway } from "../llm";
import { scripted, TEXT } from "../testing/scripted";
import type { PipelineDeps } from "./deps";
import { drainTenantJobs } from "./drain";
import { failedStage, runStage } from "./stages";

// The stage handlers against Postgres and RustFS, with a scripted transport instead of Claude.
// Covers the §10 correctness cases: both crash windows, duplicate and stale jobs, dead letters,
// refusals, the budget, reclassify runs, and tenant-independent request hashes.

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const storage = createStorage(storageConfigFromEnv());
let boss: PgBoss;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

// ── Harness ──────────────────────────────────────────────────────────────────────────────────

async function setup(
  options: {
    capUsd?: number;
    hooks?: GatewayHooks;
    auditDraw?: number;
    model?: { model: ModelRef; effort: Effort };
  } = {},
) {
  const tenantId = await newTenant(pool);
  await withTenantTx(pool, tenantId, async (tx) => {
    await buildPipelineConfig(tx, {
      classify: options.model,
      extract: options.model,
      categories: {
        invoice: { automation: "auto_when_confident", auditRate: 0 },
        support_request: { automation: "auto_when_confident", auditRate: 0 },
        contract: { automation: "review_all" },
      },
    });
    await tx.queueDb.executeSql("update tenant_settings set daily_llm_cap_usd = $1", [String(options.capUsd ?? 1000)]);
  });
  const transport = scripted();
  const deps: PipelineDeps = {
    pool,
    boss,
    storage,
    llm: createDbLlmGateway({ pool, mode: "live", transport, hooks: options.hooks }),
    limits: { maxPdfPages: 100 },
    auditDraw: () => options.auditDraw ?? 0.5,
    now: () => new Date("2026-11-03T12:00:00Z"),
  };
  const ingestText = async (text: string) =>
    (
      await ingestFile(
        { pool, boss, storage },
        tenantId,
        {
          bytes: new TextEncoder().encode(`${text}\n${randomUUID()}`),
          filename: "doc.txt",
          mime: "text/plain",
          source: "api",
        },
        { maxFileBytes: 2 ** 20 },
      )
    ).documentId;
  const detail = (documentId: string) => withTenantTx(pool, tenantId, (tx) => getDocumentDetail(tx, documentId));
  const rows = async <T>(sql: string, values: unknown[] = []) =>
    withTenantTx(pool, tenantId, async (tx) => (await tx.queueDb.executeSql(sql, values)).rows as T[]);
  const callsFor = (stage: string) => transport.calls.filter((c) => c.meta.stage === stage).length;
  return {
    tenantId,
    deps,
    transport,
    ingestText,
    detail,
    rows,
    callsFor,
    drain: () => drainTenantJobs(deps, tenantId),
  };
}

async function samplePdf(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 842]);
  lines.forEach((line, i) => {
    page.drawText(line, { x: 50, y: 780 - i * 18, size: 11, font });
  });
  return pdf.save();
}

// ── Tests ────────────────────────────────────────────────────────────────────────────────────

describe("happy paths", () => {
  it("auto-approves a clear invoice: one canonical attempt per stage, an action, a deliver job", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    const d = await t.detail(documentId);
    expect(d?.document).toMatchObject({
      processingStatus: "done",
      reviewStatus: "not_required",
      deliveryStatus: "pending",
    });
    expect(d?.run).toMatchObject({ status: "done" });
    expect(d?.classification).toMatchObject({ category: "invoice", selfConfidence: 0.97 });
    expect(d?.extraction).toMatchObject({
      revision: 1,
      author: "model",
      decision: "auto",
      decisionReasons: [],
      score: 0.97,
    });
    expect(d?.task).toBeNull();
    expect(d?.actions).toHaveLength(1);
    expect(d?.actions[0]?.payload).toMatchObject({
      event: "document.approved",
      document_id: documentId,
      extraction_id: d?.extraction?.id,
      category: "invoice",
      fields: { total: 120, invoice_number: "INV-9" },
      approved_by: "auto",
      approved_at: "2026-11-03T12:00:00.000Z",
    });
    const actionId = d?.actions[0]?.id ?? "";
    expect(await t.deps.boss.getJobById(QUEUES.deliver, actionId)).toMatchObject({ data: { actionId } });

    const calls = await t.rows<{ stage: string; canonical: boolean; mode: string; cost_usd: string }>(
      "select stage, canonical, mode, cost_usd from llm_calls order by stage",
    );
    expect(calls.map((c) => [c.stage, c.canonical, c.mode])).toEqual([
      ["classify", true, "live"],
      ["extract", true, "live"],
    ]);
    expect(Number(calls[0]?.cost_usd)).toBeCloseTo((1200 * 4 + 150 * 20) / 1e6, 8);
    const [budget] = await t.rows<{ spent_usd: string; reserved_usd: string }>(
      "select spent_usd, reserved_usd from llm_budget_days",
    );
    expect(Number(budget?.reserved_usd)).toBe(0);
    expect(Number(budget?.spent_usd)).toBeCloseTo(2 * Number(calls[0]?.cost_usd), 8);
  });

  it("parses an emailed PDF and checks quotes against the cited page", async () => {
    const t = await setup();
    const pdf = await samplePdf([
      "Globex Corporation",
      "Invoice GX-2026-114",
      "Issued 2026-09-30",
      "Amount due: 480.50",
    ]);
    const { documentId } = await ingestEmail(
      { pool, boss, storage },
      t.tenantId,
      {
        messageId: `${randomUUID()}@globex.test`,
        subject: "Invoice GX-2026-114",
        from: "billing@globex.test",
        date: "Mon, 2 Nov 2026 09:00:00 +0000",
        recipients: [],
        text: "SCENARIO pdf-invoice\nPlease find the invoice attached.",
        attachments: [
          { filename: "GX-2026-114.pdf", mime: "application/pdf", size: pdf.length, contentId: null, content: pdf },
        ],
      },
      { source: "email" },
    );
    await t.drain();
    const d = await t.detail(documentId);
    expect(d?.parts.map((p) => [p.kind, p.evidenceMode, p.page])).toEqual([
      ["email_body", "text", null],
      ["attachment", "pdf_text", 1],
    ]);
    const sent = t.transport.calls[0]?.request.params.messages[0]?.content as { type: string }[];
    expect(sent.map((b) => b.type)).toEqual(["text", "document", "text"]);
    expect(d?.extraction).toMatchObject({ decision: "auto" });
    const gates = d?.extraction?.gateResults as
      | { evidence: { checks: { status: string; page: number }[] } }
      | undefined;
    const checks = gates?.evidence.checks ?? [];
    expect(checks).toHaveLength(4);
    expect(checks.every((c) => c.status === "verified" && c.page === 1)).toBe(true);
  });

  it("sends a text PDF as page text to a model that can't read PDFs, and prices it at that model", async () => {
    const t = await setup({ model: { model: "deepseek:deepseek-flash", effort: "none" } });
    const pdf = await samplePdf([
      "Globex Corporation",
      "Invoice GX-2026-114",
      "Issued 2026-09-30",
      "Amount due: 480.50",
    ]);
    const { documentId } = await ingestEmail(
      { pool, boss, storage },
      t.tenantId,
      {
        messageId: `${randomUUID()}@globex.test`,
        subject: "Invoice GX-2026-114",
        from: "billing@globex.test",
        date: "Mon, 2 Nov 2026 09:00:00 +0000",
        recipients: [],
        text: "SCENARIO pdf-invoice\nPlease find the invoice attached.",
        attachments: [
          { filename: "GX-2026-114.pdf", mime: "application/pdf", size: pdf.length, contentId: null, content: pdf },
        ],
      },
      { source: "email" },
    );
    await t.drain();
    const first = t.transport.calls[0]?.request;
    expect(first?.provider).toBe("deepseek");
    const sent = first?.params.messages[1]?.content as { type: string; text: string }[];
    expect(sent.map((b) => b.type)).toEqual(["text", "text", "text"]);
    expect(sent[1]?.text).toContain('page="1">\nGlobex Corporation');
    const d = await t.detail(documentId);
    expect(d?.extraction).toMatchObject({ decision: "auto" });
    const gates = d?.extraction?.gateResults as { evidence: { checks: { status: string }[] } } | undefined;
    expect(gates?.evidence.checks.every((c) => c.status === "verified")).toBe(true);
    const calls = await t.rows<{ model: string; stop_reason: string; cost_usd: string }>(
      "select model, stop_reason, cost_usd from llm_calls order by created_at",
    );
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ model: "deepseek:deepseek-flash", stop_reason: "end_turn" });
      expect(Number(call.cost_usd)).toBeCloseTo((1200 * 0.3 + 150 * 1.2) / 1e6, 10);
    }
  });

  it("routes low confidence, review_all categories and `other` to the right tasks", async () => {
    const t = await setup();
    const [support, contract, newsletter] = await Promise.all(
      [TEXT.support, TEXT.contract, TEXT.newsletter].map(t.ingestText),
    );
    await t.drain();
    expect(await t.detail(support ?? "")).toMatchObject({
      document: { processingStatus: "done", reviewStatus: "pending", deliveryStatus: "none" },
      extraction: { decision: "review", decisionReasons: ["below_threshold"] },
      task: { kind: "review", status: "pending", reasons: ["below_threshold"] },
      actions: [],
    });
    expect(await t.detail(contract ?? "")).toMatchObject({ task: { kind: "review", reasons: ["automation_off"] } });
    expect(await t.detail(newsletter ?? "")).toMatchObject({
      document: { processingStatus: "done", reviewStatus: "pending" },
      classification: { category: "other" },
      extraction: null,
      task: { kind: "unclassified", reasons: ["category_other"] },
    });
    expect(t.callsFor("extract")).toBe(2); // not for `other`
  });

  it("holds a sampled auto decision for audit instead of acting", async () => {
    const t = await setup({ auditDraw: 0 });
    await withTenantTx(pool, t.tenantId, (tx) =>
      buildPipelineConfig(tx, { categories: { invoice: { automation: "auto_when_confident", auditRate: 0.5 } } }),
    );
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      extraction: { decision: "auto", decisionReasons: ["audit_sample"] },
      task: { kind: "audit" },
      actions: [],
      document: { reviewStatus: "pending", deliveryStatus: "none" },
    });
  });
});

describe("failures", () => {
  it("fails the run on a refusal and hands it to a human", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.refusal);
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      document: { processingStatus: "failed", reviewStatus: "pending" },
      run: { status: "failed", error: expect.stringContaining("llm_refusal") },
      task: { kind: "processing_failed", reasons: ["llm_refusal"] },
    });
    const calls = await t.rows<{ error: string; canonical: boolean }>("select error, canonical from llm_calls");
    expect(calls).toMatchObject([{ canonical: false, error: expect.stringContaining("cyber") }]);
  });

  it("fails the run when the daily budget can't cover the call, without calling Claude", async () => {
    const t = await setup({ capUsd: 0 });
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      task: { kind: "processing_failed", reasons: ["budget_exhausted"] },
    });
    expect(t.transport.calls).toHaveLength(0);
  });

  it("fails an unsupported file at parse", async () => {
    const t = await setup();
    const { documentId } = await ingestFile(
      { pool, boss, storage },
      t.tenantId,
      { bytes: new TextEncoder().encode("not really a PNG"), filename: "x.png", mime: "image/png", source: "api" },
      { maxFileBytes: 2 ** 20 },
    );
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      task: { kind: "processing_failed", reasons: ["unsupported_file"] },
    });
  });
});

describe("crash windows (invariant 4)", () => {
  it("after the attempt is saved: the retry reuses it and makes no second call", async () => {
    let crashed = false;
    const t = await setup({
      hooks: {
        afterAttemptSaved: ({ stage }) => {
          if (stage === "classify" && !crashed) {
            crashed = true;
            throw new Error("worker crashed after saving");
          }
        },
      },
    });
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    expect(crashed).toBe(true);
    expect(t.callsFor("classify")).toBe(1);
    const calls = await t.rows<{ stage: string; canonical: boolean }>(
      "select stage, canonical from llm_calls where stage = 'classify'",
    );
    expect(calls).toEqual([{ stage: "classify", canonical: true }]);
    expect(await t.detail(documentId)).toMatchObject({
      extraction: { decision: "auto" },
      actions: [expect.anything()],
    });
  });

  it("before the attempt is saved: a second call, but one canonical attempt, one extraction, one action", async () => {
    let crashed = false;
    const t = await setup({
      hooks: {
        afterResponse: ({ stage }) => {
          if (stage === "extract" && !crashed) {
            crashed = true;
            throw new Error("worker crashed before saving");
          }
        },
      },
    });
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    expect(t.callsFor("extract")).toBe(2);
    const extractCalls = await t.rows<{ canonical: boolean }>(
      "select canonical from llm_calls where stage = 'extract'",
    );
    expect(extractCalls.filter((c) => c.canonical)).toHaveLength(1);
    const d = await t.detail(documentId);
    expect(await t.rows("select id from extractions")).toHaveLength(1);
    expect(d?.actions).toHaveLength(1);
  });
});

describe("idempotency", () => {
  it("ignores a redelivered job for a stage that already committed", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    const runId = (await t.detail(documentId))?.document.currentRunId ?? "";
    const job: StageJob = { tenantId: t.tenantId, documentId, runId };
    for (const stage of ["parse", "classify", "extract", "route"] as const) await runStage(t.deps, stage, job);
    expect(t.transport.calls).toHaveLength(2);
    expect(await t.rows("select id from classifications")).toHaveLength(1);
    expect(await t.rows("select id from extractions")).toHaveLength(1);
    expect(await t.rows("select id from actions")).toHaveLength(1);
    expect(await t.rows("select id from document_parts")).toHaveLength(1);
  });

  it("a stale run (superseded by a newer one) writes nothing", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.invoice);
    const runId = (await t.detail(documentId))?.document.currentRunId ?? "";
    const job: StageJob = { tenantId: t.tenantId, documentId, runId };
    await runStage(t.deps, "parse", job);
    // Another run takes over the document (as a retry or reclassify would).
    await t.rows(
      `with r as (insert into processing_runs (tenant_id, document_id, config_id, trigger)
                  select tenant_id, document_id, config_id, 'retry' from processing_runs where id = $1 returning id)
       update documents set current_run_id = (select id from r) where id = $2`,
      [runId, documentId],
    );
    await runStage(t.deps, "classify", job);
    expect(t.transport.calls).toHaveLength(0);
    expect(await t.rows("select id from classifications")).toEqual([]);
  });

  it("a job dead-lettered after its stage committed doesn't fail the document", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    const runId = (await t.detail(documentId))?.document.currentRunId ?? "";
    await failedStage(
      t.deps,
      { tenantId: t.tenantId, documentId, runId },
      { queue: QUEUES.classify, output: { message: "expired" } },
    );
    expect(await t.detail(documentId)).toMatchObject({ document: { processingStatus: "done" }, task: null });
  });

  it("dead-letters a job that keeps failing, and fails the run", async () => {
    const t = await setup();
    t.deps.llm = { call: () => Promise.reject(new Error("overloaded")) };
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      document: { processingStatus: "failed" },
      run: { error: expect.stringContaining("overloaded") },
      task: { kind: "processing_failed", reasons: ["retries_exhausted"] },
    });
  });
});

describe("reclassify runs", () => {
  it("start at extract with the forced category and always go to a human", async () => {
    const t = await setup();
    const documentId = await t.ingestText(TEXT.invoice);
    await t.drain();
    const configId = (await t.detail(documentId))?.run?.configId ?? "";
    await withTenantTx(pool, t.tenantId, (tx) =>
      startRun(tx, boss, { documentId, configId, trigger: "reclassify", forcedCategory: "invoice" }),
    );
    await t.drain();
    expect(await t.detail(documentId)).toMatchObject({
      document: { processingStatus: "done", reviewStatus: "pending" },
      extraction: { revision: 2, decision: "review", score: null },
      task: { kind: "review" },
    });
    const reasons = (await t.detail(documentId))?.extraction?.decisionReasons;
    expect(reasons).toEqual(expect.arrayContaining(["reclassify_run", "no_score"]));
  });
});

describe("cassette keys", () => {
  it("hash the same document identically in two tenants", async () => {
    const [a, b] = [await setup(), await setup()];
    const bytes = new TextEncoder().encode(TEXT.invoice);
    for (const t of [a, b]) {
      await ingestFile(
        { pool, boss, storage },
        t.tenantId,
        { bytes, filename: "same.txt", mime: "text/plain", source: "api" },
        { maxFileBytes: 2 ** 20 },
      );
      await t.drain();
    }
    const hashes = (t: typeof a) => t.transport.calls.map((c) => `${c.meta.stage}:${c.meta.hash}`);
    expect(hashes(a)).toHaveLength(2);
    expect(hashes(a)).toEqual(hashes(b));
  });
});
