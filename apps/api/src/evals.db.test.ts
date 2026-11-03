import { randomUUID } from "node:crypto";
import type {
  ClaimResponse,
  ConfigList,
  ConfigResponse,
  DecisionResponse,
  ErrorResponse,
  EvalItemList,
  EvalRunCreated,
  EvalRunDetail,
  EvalRunList,
} from "@ai-triage/contracts";
import {
  buildPipelineConfig,
  commitEvalResult,
  getDocumentDetail,
  getOrCreateDataset,
  insertEvalItem,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, SAMPLE_INVOICE_FIELDS, seedReviewTask } from "@ai-triage/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app";

// Evals over HTTP (docs/architecture.md §8, §10): "Add to eval set" on approvals, runs and their
// refusals (test needs a frozen config), Freeze from calib, configs, and the production tab.

const t = await createTestApp();
const { app, pool, storage } = t;
afterAll(t.close);

async function setup() {
  const tenantId = await newTenant(pool);
  const configId = await withTenantTx(pool, tenantId, async (tx) => (await buildPipelineConfig(tx)).id);
  const [admin, reviewer, viewer] = await Promise.all([
    t.memberCookie(tenantId, "admin"),
    t.memberCookie(tenantId, "reviewer"),
    t.memberCookie(tenantId, "viewer"),
  ]);
  const inTenant = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) => withTenantTx(pool, tenantId, fn);
  /** A review task whose document has a real source object, so it can be copied into the eval set. */
  const seed = async (input: Parameters<typeof seedReviewTask>[1] = {}) => {
    const task = await inTenant((tx) => seedReviewTask(tx, input));
    const [doc] = (
      await inTenant((tx) =>
        tx.queueDb.executeSql(
          "update documents set mime = 'text/plain', title = 'invoice.txt' where id = $1 returning *",
          [task.documentId],
        ),
      )
    ).rows as { source_key: string; external_id: string }[];
    await storage.put(
      doc?.source_key ?? "",
      new TextEncoder().encode(`Invoice INV-1001 ${randomUUID()}`),
      "text/plain",
    );
    return { ...task, externalId: doc?.external_id ?? "" };
  };
  const items = async () => {
    const res = await get(`/evals/datasets/${(await inTenant((tx) => getOrCreateDataset(tx))).id}/items`, viewer);
    return ((await res.json()) as EvalItemList).items;
  };
  return { tenantId, configId, admin, reviewer, viewer, inTenant, seed, items };
}

const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
const post = (path: string, cookie: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function refused(res: Response, status: number, code?: string): Promise<ErrorResponse> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ErrorResponse;
  if (code) expect(body.code).toBe(code);
  return body;
}

async function approve(
  s: Awaited<ReturnType<typeof setup>>,
  task: { taskId: string; extractionId: string | null },
  extra: object,
) {
  const claimed = (await (await post(`/review/tasks/${task.taskId}/claim`, s.reviewer)).json()) as ClaimResponse;
  return post(`/review/tasks/${task.taskId}/decisions`, s.reviewer, {
    action: "approve",
    claimToken: claimed.claimToken,
    extractionId: task.extractionId,
    ...extra,
  });
}

describe("Add to eval set", () => {
  it("labels a new item with the approved revision and a copy of the source", async () => {
    const s = await setup();
    const task = await s.seed();
    const res = await approve(s, task, { addToEvalSet: { split: "calib" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DecisionResponse;
    expect(body.evalItem).toMatchObject({ split: "calib", duplicate: false });
    expect(await s.items()).toEqual([
      expect.objectContaining({
        id: body.evalItem?.id,
        split: "calib",
        expectedCategory: "invoice",
        expectedFields: SAMPLE_INVOICE_FIELDS,
        origin: "review",
        originRef: `decision:${body.decisionId}`,
        tags: ["review:approved"],
        sourceTitle: "invoice.txt",
        sourceMime: "text/plain",
      }),
    ]);
  });

  it("labels an edit with the edited values", async () => {
    const s = await setup();
    const task = await s.seed();
    const claimed = (await (await post(`/review/tasks/${task.taskId}/claim`, s.reviewer)).json()) as ClaimResponse;
    const res = await post(`/review/tasks/${task.taskId}/decisions`, s.reviewer, {
      action: "edit_approve",
      claimToken: claimed.claimToken,
      extractionId: task.extractionId,
      fields: { ...SAMPLE_INVOICE_FIELDS, invoice_number: "INV-2002" },
      addToEvalSet: { split: "dev" },
    });
    expect(res.status).toBe(200);
    expect(await s.items()).toEqual([
      expect.objectContaining({
        expectedFields: expect.objectContaining({ invoice_number: "INV-2002" }),
        tags: ["review:edited"],
      }),
    ]);
  });

  it("reports content already in the set instead of adding it twice", async () => {
    const s = await setup();
    const first = await s.seed();
    const second = await s.seed();
    // The same email, received twice (by different routes): same external id, so same content.
    await s.inTenant((tx) =>
      tx.queueDb.executeSql("update documents set source = 'email', external_id = $1 where id = $2", [
        first.externalId,
        second.documentId,
      ]),
    );
    const one = (await (await approve(s, first, { addToEvalSet: { split: "dev" } })).json()) as DecisionResponse;
    const two = (await (await approve(s, second, { addToEvalSet: { split: "test" } })).json()) as DecisionResponse;
    expect(two.evalItem).toEqual({ id: one.evalItem?.id, split: "dev", duplicate: true });
    expect(await s.items()).toHaveLength(1);
  });

  it("writes nothing when the decision is refused, or when the values can't be a label", async () => {
    const s = await setup();
    const task = await s.seed();
    await refused(
      await post(`/review/tasks/${task.taskId}/decisions`, s.reviewer, {
        action: "approve",
        claimToken: randomUUID(),
        extractionId: task.extractionId,
        addToEvalSet: { split: "dev" },
      }),
      409,
      "claim_lost",
    );
    const invalid = await s.seed({ fields: { ...SAMPLE_INVOICE_FIELDS, invoice_date: "yesterday" } });
    await refused(await approve(s, invalid, { addToEvalSet: { split: "dev" } }), 422, "invalid_fields");
    const detail = await s.inTenant((tx) => getDocumentDetail(tx, invalid.documentId));
    expect(detail?.actions).toEqual([]);
    expect(await s.items()).toEqual([]);
  });
});

async function dataset(s: Awaited<ReturnType<typeof setup>>, splits: ("dev" | "calib" | "test")[]) {
  return s.inTenant(async (tx) => {
    const { id } = await getOrCreateDataset(tx);
    const itemIds: string[] = [];
    for (const split of splits) {
      const item = await insertEvalItem(tx, {
        datasetId: id,
        source: { sourceKey: "k", sourceMime: "text/plain", sourceTitle: null, contentKey: randomUUID() },
        expectedCategory: "invoice",
        expectedFields: {},
        split,
        origin: "seed",
      });
      itemIds.push(item.id);
    }
    return { datasetId: id, itemIds };
  });
}

describe("eval runs", () => {
  it("lets admins start runs, and refuses test on an unfrozen config and empty splits", async () => {
    const s = await setup();
    const { datasetId } = await dataset(s, ["dev", "test"]);
    const run = { datasetId, split: "dev", configId: s.configId };
    await refused(await post("/evals/runs", s.viewer, run), 403);
    await refused(await post("/evals/runs", s.reviewer, run), 403);
    await refused(await post("/evals/runs", s.admin, { ...run, split: "test" }), 422, "config_not_frozen");
    await refused(await post("/evals/runs", s.admin, { ...run, split: "calib" }), 422, "empty_split");
    const res = await post("/evals/runs", s.admin, run);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ itemCount: 1 });
    const list = (await (await get("/evals/runs", s.viewer)).json()) as EvalRunList;
    expect(list).toMatchObject({ newRunMode: "replay", runs: [{ split: "dev", status: "queued", llmMode: "replay" }] });
  });

  it("hides another tenant's runs", async () => {
    const s = await setup();
    const other = await setup();
    const { datasetId } = await dataset(s, ["dev"]);
    const { runId } = (await (
      await post("/evals/runs", s.admin, { datasetId, split: "dev", configId: s.configId })
    ).json()) as EvalRunCreated;
    expect((await get(`/evals/runs/${runId}`, other.viewer)).status).toBe(404);
    expect((await get(`/evals/runs/${runId}`, s.viewer)).status).toBe(200);
  });

  it("freezes a finished calib run's config, which can then run test and be activated", async () => {
    const s = await setup();
    const { datasetId, itemIds } = await dataset(s, ["calib", "dev", "test"]);
    const start = async (split: string, configId = s.configId) =>
      ((await (await post("/evals/runs", s.admin, { datasetId, split, configId })).json()) as EvalRunCreated).runId;
    const calib = await start("calib");
    const dev = await start("dev");
    const freeze = {
      name: "Calibrated",
      categories: [{ category: "invoice", threshold: 0.8, automation: "auto_when_confident", auditRate: 0.1 }],
    };
    await refused(await post(`/evals/runs/${calib}/freeze`, s.admin, freeze), 409, "run_not_done");
    await refused(await post(`/evals/runs/${dev}/freeze`, s.admin, freeze), 422, "not_calib_run");
    await refused(await post(`/evals/runs/${calib}/freeze`, s.reviewer, freeze), 403);

    await s.inTenant((tx) =>
      commitEvalResult(tx, {
        evalRunId: calib,
        evalItemId: itemIds[0] ?? "",
        predictedCategory: "invoice",
        predictedFields: {},
        score: 0.85,
        decision: "review",
        reasons: ["below_threshold"],
        gateResults: null,
        grade: { categoryCorrect: true, requiredCorrect: true, fullyCorrect: true, fieldScores: {} },
        proposedAction: null,
        classifyCallId: null,
        extractCallId: null,
        error: null,
      }),
    );
    const detail = (await (await get(`/evals/runs/${calib}`, s.viewer)).json()) as EvalRunDetail;
    expect(detail.run.status).toBe("done");
    expect(detail.metrics?.summary).toMatchObject({ n: 1 });
    expect(detail.sweeps.find((w) => w.category === "invoice")).toMatchObject({ n: 1, eligible: 1 });

    const res = await post(`/evals/runs/${calib}/freeze`, s.admin, freeze);
    expect(res.status).toBe(201);
    const { config } = (await res.json()) as ConfigResponse;
    expect(config).toMatchObject({ parentId: s.configId, frozenAt: expect.any(String), active: false });
    expect(config.categories.find((c) => c.category === "invoice")).toMatchObject({ threshold: 0.8 });

    expect(await start("test", config.id)).toEqual(expect.any(String));
    await refused(await post(`/configs/${s.configId}/activate`, s.admin), 422, "config_not_frozen");
    const activated = await post(`/configs/${config.id}/activate`, s.admin);
    expect(activated.status).toBe(200);
    expect(((await activated.json()) as ConfigResponse).config.active).toBe(true);
  });

  it("only diffs runs of the same dataset and split", async () => {
    const s = await setup();
    const { datasetId } = await dataset(s, ["dev", "calib"]);
    const start = async (split: string) =>
      (
        (await (
          await post("/evals/runs", s.admin, { datasetId, split, configId: s.configId })
        ).json()) as EvalRunCreated
      ).runId;
    const [a, b, c] = [await start("dev"), await start("dev"), await start("calib")];
    expect((await get(`/evals/diff?a=${a}&b=${b}`, s.viewer)).status).toBe(200);
    await refused(await get(`/evals/diff?a=${a}&b=${c}`, s.viewer), 422, "runs_not_comparable");
  });
});

describe("configs", () => {
  it("creates candidates the model catalog accepts", async () => {
    const s = await setup();
    await refused(
      await post("/configs", s.admin, { parentId: s.configId, name: "x", classify: { model: "gpt-1" } }),
      422,
      "invalid_config",
    );
    await refused(await post("/configs", s.viewer, { parentId: s.configId, name: "x" }), 403);
    const res = await post("/configs", s.admin, {
      parentId: s.configId,
      name: "DeepSeek candidate",
      classify: { model: "deepseek:deepseek-flash", effort: "low" },
      extract: { model: "deepseek:deepseek-flash", effort: "low" },
    });
    expect(res.status).toBe(201);
    const list = (await (await get("/configs", s.viewer)).json()) as ConfigList;
    expect(list.configs.map((c) => [c.name, c.active, c.frozenAt])).toEqual([
      ["DeepSeek candidate", false, null],
      [expect.any(String), true, null],
    ]);
    expect(list.promptVersions.map((p) => p.stage).sort()).toEqual(["classify", "extract"]);
  });
});

describe("production", () => {
  it("reports the window's metrics", async () => {
    const s = await setup();
    const res = await get("/evals/production?days=7", s.viewer);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      days: 7,
      replay: false,
      spend: { calls: 0 },
      auditPrecision: { n: 0, rate: null },
    });
  });
});
