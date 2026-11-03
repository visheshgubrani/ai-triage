import { randomUUID } from "node:crypto";
import {
  buildPipelineConfig,
  createBoss,
  createEvalRun,
  createPool,
  getOrCreateDataset,
  insertEvalItem,
  type PgBoss,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { importEvalSource } from "@ai-triage/ingest";
import { fakeTransport, type GatewayHooks, type Transport } from "@ai-triage/llm";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbLlmGateway } from "../llm";
import { scripted, TEXT } from "../testing/scripted";
import type { EvalDeps } from "./deps";
import { drainEvalJobs } from "./drain";

// The eval runner against Postgres and RustFS with a scripted model (docs/architecture.md §8, §10):
// it grades items with the pipeline's own code, survives both crash windows, turns failures into
// error results, refuses a mode mismatch, and never creates a document, a task or an action.

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

const LABELS = {
  invoice: {
    text: TEXT.invoice,
    category: "invoice",
    fields: { vendor_name: "Acme Supplies Ltd", invoice_number: "INV-9", invoice_date: "2026-10-01", total: 120 },
  },
  newsletter: { text: TEXT.newsletter, category: "other", fields: {} },
  refusal: { text: TEXT.refusal, category: "invoice", fields: {} },
  contract: {
    text: TEXT.contract,
    category: "contract",
    fields: {
      contract_type: "nda",
      parties: [{ name: "Northwind Ltd" }, { name: "Contoso GmbH" }],
      effective_date: "2026-03-01",
    },
  },
} as const;
type LabelName = keyof typeof LABELS;

async function setup(
  options: { items?: LabelName[]; hooks?: GatewayHooks; transport?: Transport; runMode?: "live" | "replay" } = {},
) {
  const tenantId = await newTenant(pool);
  const transport = options.transport ?? scripted();
  const deps: EvalDeps = {
    pool,
    storage,
    llm: createDbLlmGateway({ pool, mode: "live", transport, hooks: options.hooks }),
    limits: { maxPdfPages: 100 },
    llmMode: "live",
    now: () => new Date("2026-11-03T12:00:00Z"),
  };
  const items = new Map<string, LabelName>();
  const runId = await withTenantTx(pool, tenantId, async (tx) => {
    await buildPipelineConfig(tx, {
      categories: {
        invoice: { automation: "auto_when_confident", auditRate: 0.5 },
        support_request: { automation: "auto_when_confident" },
        contract: { automation: "review_all" },
      },
    });
    await tx.queueDb.executeSql("update tenant_settings set daily_llm_cap_usd = 1000");
    const config = await tx.queueDb.executeSql("select active_config_id as id from tenant_settings");
    const dataset = await getOrCreateDataset(tx);
    for (const name of options.items ?? (Object.keys(LABELS) as LabelName[])) {
      const label = LABELS[name];
      const source = await importEvalSource(storage, tenantId, {
        kind: "file",
        bytes: new TextEncoder().encode(`${label.text}\n${randomUUID()}`),
        filename: "doc.txt",
        mime: "text/plain",
      });
      const { id } = await insertEvalItem(tx, {
        datasetId: dataset.id,
        source,
        expectedCategory: label.category,
        expectedFields: label.fields,
        split: "dev",
        origin: "seed",
      });
      items.set(id, name);
    }
    const configId = (config.rows[0] as { id: string }).id;
    return (
      await createEvalRun(tx, boss, {
        datasetId: dataset.id,
        split: "dev",
        configId,
        llmMode: options.runMode ?? "live",
      })
    ).runId;
  });
  const rows = async <T>(sql: string, values: unknown[] = []) =>
    withTenantTx(pool, tenantId, async (tx) => (await tx.queueDb.executeSql(sql, values)).rows as T[]);
  const result = async (name: LabelName) => {
    const id = [...items].find(([, n]) => n === name)?.[0];
    const [row] = await rows<Record<string, unknown>>("select * from eval_results where eval_item_id = $1", [id]);
    return row;
  };
  const run = async () => (await rows<Record<string, unknown>>("select * from eval_runs where id = $1", [runId]))[0];
  const callsFor = (stage: string) =>
    (transport as ReturnType<typeof scripted>).calls?.filter((c) => c.meta.stage === stage).length ?? 0;
  return { tenantId, deps, runId, rows, result, run, callsFor, drain: () => drainEvalJobs(deps, boss, tenantId) };
}

describe("an eval run", () => {
  it("grades every item with the pipeline's code and finishes with summary metrics", async () => {
    const t = await setup();
    await t.drain();

    expect(await t.result("invoice")).toMatchObject({
      predicted_category: "invoice",
      score: "0.970",
      decision: "auto",
      reasons: [],
      category_correct: true,
      required_correct: true,
      error: null,
    });
    // The proposed action is stored for inspection; its "document" is the eval item.
    const invoice = await t.result("invoice");
    expect(invoice?.proposed_action).toMatchObject({ type: "webhook", document_id: invoice?.eval_item_id });
    expect(await t.result("contract")).toMatchObject({ decision: "review", reasons: ["automation_off"] });
    expect(await t.result("newsletter")).toMatchObject({
      predicted_category: "other",
      decision: "review",
      reasons: ["category_other"],
      category_correct: true,
      required_correct: true,
      extract_call_id: null,
    });
    expect(await t.result("refusal")).toMatchObject({
      decision: null,
      error_reason: "llm_refusal",
      category_correct: false,
      required_correct: false,
    });
    // `other` and the refusal make no extract call.
    expect(t.callsFor("extract")).toBe(2);

    expect(await t.run()).toMatchObject({
      status: "done",
      aggregates: expect.objectContaining({ n: 4, errors: 1, autoPrecision: expect.objectContaining({ k: 1, n: 1 }) }),
    });
    const canonical = await t.rows<{ stage: string; n: string }>(
      "select stage, count(*) as n from llm_calls where canonical group by stage order by stage",
    );
    expect(canonical).toEqual([
      { stage: "classify", n: "3" },
      { stage: "extract", n: "2" },
    ]);
  });

  it("creates no documents, review tasks or actions (invariant 7)", async () => {
    const t = await setup();
    await t.drain();
    const counts = await t.rows<{ documents: string; tasks: string; actions: string; runs: string }>(
      `select (select count(*) from documents) as documents, (select count(*) from review_tasks) as tasks,
              (select count(*) from actions) as actions, (select count(*) from processing_runs) as runs`,
    );
    expect(counts).toEqual([{ documents: "0", tasks: "0", actions: "0", runs: "0" }]);
    expect(await t.rows("select id from llm_calls where processing_run_id is not null")).toEqual([]);
  });

  it("costs exactly the sum of its llm_calls rows", async () => {
    const t = await setup({ items: ["invoice", "contract"] });
    await t.drain();
    const [sum] = await t.rows<{ total: string }>(
      "select sum(cost_usd)::float8 as total from llm_calls where eval_run_id = $1",
      [t.runId],
    );
    const run = await t.run();
    expect((run?.aggregates as { totalUsd?: number } | undefined)?.totalUsd).toBeCloseTo(Number(sum?.total), 6);
  });
});

describe("crash windows (invariant 4)", () => {
  it("after the attempt is saved: the retry reuses it and makes no second call", async () => {
    let crashed = false;
    const t = await setup({
      items: ["invoice"],
      hooks: {
        afterAttemptSaved: ({ stage }) => {
          if (stage === "classify" && !crashed) {
            crashed = true;
            throw new Error("worker crashed after saving");
          }
        },
      },
    });
    await t.drain();
    expect(crashed).toBe(true);
    expect(t.callsFor("classify")).toBe(1);
    expect(await t.rows("select canonical from llm_calls where stage = 'classify'")).toEqual([{ canonical: true }]);
    expect(await t.result("invoice")).toMatchObject({ decision: "auto", error: null });
  });

  it("before the attempt is saved: a second call, but one canonical attempt and one result", async () => {
    let crashed = false;
    const t = await setup({
      items: ["invoice"],
      hooks: {
        afterResponse: ({ stage }) => {
          if (stage === "extract" && !crashed) {
            crashed = true;
            throw new Error("worker crashed before saving");
          }
        },
      },
    });
    await t.drain();
    expect(t.callsFor("extract")).toBe(2);
    expect(await t.rows("select canonical from llm_calls where stage = 'extract' and canonical")).toHaveLength(1);
    expect(await t.rows("select id from eval_results")).toHaveLength(1);
  });
});

describe("failures", () => {
  it("gives an item that keeps failing a retries_exhausted result, so the run still finishes", async () => {
    const t = await setup({
      items: ["invoice"],
      transport: fakeTransport(() => {
        throw new Error("connection reset");
      }),
    });
    await t.drain();
    expect(await t.result("invoice")).toMatchObject({ error_reason: "retries_exhausted", decision: null });
    expect(await t.run()).toMatchObject({ status: "done" });
  });

  it("fails the run when the worker's mode differs from the run's, without calling the model", async () => {
    const t = await setup({ items: ["invoice"], runMode: "replay" });
    await t.drain();
    expect(await t.run()).toMatchObject({ status: "failed", error: expect.stringContaining("mode_mismatch") });
    expect(t.callsFor("classify")).toBe(0);
    expect(await t.rows("select id from eval_results")).toEqual([]);
  });
});
