import {
  type ConfigResponse,
  type EvalDatasetList,
  EvalDiffQuery,
  type EvalDiffResponse,
  type EvalItemList,
  EvalItemsQuery,
  type EvalRunCreated,
  type EvalRunDetail,
  type EvalRunList,
  EvalRunRequest,
  EvalRunsQuery,
  FreezeRequest,
  ProductionQuery,
  type ProductionResponse,
  type SourceUrlResponse,
} from "@ai-triage/contracts";
import {
  createEvalRun,
  EvalRequestError,
  freezeCalibratedConfig,
  getConfig,
  getEvalItem,
  getEvalRun,
  listDatasets,
  listItems,
  listRuns,
  loadRunCalls,
  loadRunResults,
  productionMetrics,
  recordAudit,
  retireEvalItem,
  withTenantTx,
} from "@ai-triage/db";
import { diffRuns, reliabilityTable, runMetrics, thresholdSweep } from "@ai-triage/evals";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { toConfigSummary, toEvalItem, toEvalRun } from "../evals";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

const DAY_MS = 86_400_000;

/**
 * Evals (docs/architecture.md §8). Every member reads; admins start runs (which may spend money in
 * live mode), freeze configs and retire items. Refusals carry a `code` (see EVAL_ERROR_STATUS).
 */
export const evalRoutes = (deps: AppDeps) => {
  const admin = requireRole("admin");
  return new Hono<TenantEnv>()
    .use(requireTenant(deps), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/datasets", async (c) => {
      const datasets = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) => listDatasets(tx));
      const body: EvalDatasetList = {
        datasets: datasets.map((d) => ({ ...d, createdAt: d.createdAt.toISOString() })),
      };
      return c.json(body, 200);
    })
    .get("/datasets/:id/items", idParam, validate("query", EvalItemsQuery), async (c) => {
      const q = c.req.valid("query");
      const items = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        listItems(tx, c.req.valid("param").id, { split: q.split, includeRetired: q.retired === "1" }),
      );
      const body: EvalItemList = { items: items.map(toEvalItem) };
      return c.json(body, 200);
    })
    .post("/items/:id/retire", admin, idParam, async (c) => {
      const id = c.req.valid("param").id;
      const retired = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const done = await retireEvalItem(tx, id, deps.now());
        if (done)
          await recordAudit(tx, userActor(c, deps), { action: "eval_item.retired", target: { type: "eval_item", id } });
        return done;
      });
      if (!retired) return c.json({ error: "Not found" }, 404);
      return c.json({ retired }, 200);
    })
    .get("/items/:id/source", idParam, async (c) => {
      const item = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        getEvalItem(tx, c.req.valid("param").id),
      );
      if (!item) return c.json({ error: "Not found" }, 404);
      const body: SourceUrlResponse = {
        url: await deps.storage.presignGet(item.sourceKey, 300, { mime: item.sourceMime, filename: item.sourceTitle }),
      };
      return c.json(body, 200);
    })
    .get("/runs", validate("query", EvalRunsQuery), async (c) => {
      const runs = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        listRuns(tx, { datasetId: c.req.valid("query").datasetId }),
      );
      const body: EvalRunList = { runs: runs.map(toEvalRun), newRunMode: deps.llmMode };
      return c.json(body, 200);
    })
    .post("/runs", admin, validate("json", EvalRunRequest), async (c) => {
      const input = c.req.valid("json");
      const body: EvalRunCreated = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const created = await createEvalRun(tx, deps.boss, {
          ...input,
          llmMode: deps.llmMode,
          createdBy: c.var.tenant.user.id,
        });
        // A live run spends money, so who started it is worth keeping.
        await recordAudit(tx, userActor(c, deps), {
          action: "eval_run.created",
          target: { type: "eval_run", id: created.runId },
          details: { split: input.split, configId: input.configId, llmMode: deps.llmMode },
        });
        return created;
      });
      return c.json(body, 201);
    })
    .get("/runs/:id", idParam, async (c) => {
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<EvalRunDetail | null> => {
        const entry = await getEvalRun(tx, c.req.valid("param").id);
        if (!entry) return null;
        const config = await getConfig(tx, entry.run.configId);
        if (!config) throw new Error(`config ${entry.run.configId} not found`);
        const results = await loadRunResults(tx, entry.run.id);
        const calls = await loadRunCalls(tx, entry.run.id);
        return {
          run: toEvalRun(entry),
          config: toConfigSummary(config),
          metrics: entry.run.status === "done" ? runMetrics(results, calls) : null,
          sweeps: config.categories.map((k) => thresholdSweep(results, k.category, Number(k.threshold))),
          reliability: reliabilityTable(results),
          results,
        };
      });
      if (!body) return c.json({ error: "Not found" }, 404);
      return c.json(body, 200);
    })
    .post("/runs/:id/freeze", admin, idParam, validate("json", FreezeRequest), async (c) => {
      const input = c.req.valid("json");
      const runId = c.req.valid("param").id;
      const config = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const frozen = await freezeCalibratedConfig(tx, { runId, ...input, createdBy: c.var.tenant.user.id });
        await recordAudit(tx, userActor(c, deps), {
          action: "config.frozen",
          target: { type: "config", id: frozen.id },
          details: { fromRun: runId },
        });
        return frozen;
      });
      const body: ConfigResponse = { config: toConfigSummary(config) };
      return c.json(body, 201);
    })
    .get("/diff", validate("query", EvalDiffQuery), async (c) => {
      const { a, b } = c.req.valid("query");
      const body = await withTenantTx(
        deps.pool,
        c.var.tenant.tenantId,
        async (tx): Promise<EvalDiffResponse | null> => {
          const [runA, runB] = [await getEvalRun(tx, a), await getEvalRun(tx, b)];
          if (!runA || !runB) return null;
          if (runA.run.datasetId !== runB.run.datasetId || runA.run.split !== runB.run.split) {
            throw new EvalRequestError("runs_not_comparable", "Compare runs of the same dataset and split.");
          }
          const [resultsA, resultsB] = [await loadRunResults(tx, a), await loadRunResults(tx, b)];
          return {
            a: toEvalRun(runA),
            b: toEvalRun(runB),
            diff: diffRuns(resultsA, resultsB),
            titles: Object.fromEntries([...resultsA, ...resultsB].map((r) => [r.itemId, r.sourceTitle])),
          };
        },
      );
      if (!body) return c.json({ error: "Not found" }, 404);
      return c.json(body, 200);
    })
    .get("/production", validate("query", ProductionQuery), async (c) => {
      const { days } = c.req.valid("query");
      const until = deps.now();
      const since = new Date(until.getTime() - days * DAY_MS);
      const metrics = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        productionMetrics(tx, { since, until }),
      );
      const body: ProductionResponse = { ...metrics, since: since.toISOString(), until: until.toISOString(), days };
      return c.json(body, 200);
    });
};
