import { type ModelList, type ModelOption, PipelineChangeRequest, type PipelineSettings } from "@ai-triage/contracts";
import { type Effort, MODEL_CATALOG, type ModelRef, modelBlocker, modelInfo } from "@ai-triage/core";
import { senderPolicy } from "@ai-triage/core/pipeline";
import {
  activateConfig,
  createCandidateConfig,
  getActiveConfig,
  getConfig,
  liveWorkers,
  recordAudit,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { toConfigSummary } from "../evals";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";

// Settings → Pipeline (docs/architecture.md §8): pick the models without running evals first. A
// change makes a new version in which every category is reviewed by a person, because thresholds
// calibrated for one model mean nothing for another; such a version needs no freezing to activate.
// Auto-approval comes back through the evals flow (calib, Freeze, Activate).

/** Every catalog model, and whether some running worker can call it (from its heartbeat). */
export const modelRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>().use(requireTenant(deps)).get("/", async (c) => {
    const workers = await liveWorkers(deps.db, deps.now());
    const models: ModelOption[] = (Object.keys(MODEL_CATALOG) as ModelRef[]).map((ref) => {
      const info = modelInfo(ref);
      const recordedEffort =
        workers.flatMap((w) => w.capabilities.recorded).find((r) => r.model === ref)?.effort ?? null;
      const effort = recordedEffort ?? info.efforts[0] ?? "none";
      const reasons = workers.map((w) =>
        modelBlocker({ model: ref, effort }, { llmMode: w.llmMode, ...w.capabilities }),
      );
      const available = reasons.includes(null);
      return {
        ref,
        provider: info.provider,
        efforts: [...info.efforts],
        recordedEffort,
        available,
        reason: available ? null : workers.length === 0 ? "no worker is running" : (reasons[0] ?? null),
      };
    });
    const body: ModelList = { models };
    return c.json(body, 200);
  });

export const pipelineRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), requireRole("admin"), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/", async (c) => {
      const config = await withTenantTx(deps.pool, c.var.tenant.tenantId, getActiveConfig);
      if (!config) return c.json({ error: "The workspace has no active pipeline config" }, 404);
      const body: PipelineSettings = {
        config: toConfigSummary(config, config.id),
        senderRequire: senderPolicy(config.policy).require,
      };
      return c.json(body, 200);
    })
    .put("/", validate("json", PipelineChangeRequest), async (c) => {
      const input = c.req.valid("json");
      const config = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const active = await getActiveConfig(tx);
        if (!active) throw new Error("the workspace has no active pipeline config");
        const sender = senderPolicy(active.policy);
        const created = await createCandidateConfig(tx, {
          parentId: active.id,
          name: `${input.classify.model} / ${input.extract.model}`,
          classify: { model: input.classify.model as ModelRef, effort: input.classify.effort as Effort },
          extract: { model: input.extract.model as ModelRef, effort: input.extract.effort as Effort },
          categories: active.categories.map((cat) => ({
            category: cat.category,
            threshold: Number(cat.threshold),
            automation: "review_all" as const,
            auditRate: Number(cat.auditRate),
          })),
          sender: { ...sender, trustedAuthServIds: [...sender.trustedAuthServIds], require: input.senderRequire },
          createdBy: c.var.tenant.user.id,
        });
        await activateConfig(tx, created.id);
        const actor = userActor(c, deps);
        await recordAudit(tx, actor, {
          action: "config.created",
          target: { type: "config", id: created.id },
          details: { parentId: active.id, from: "settings" },
        });
        await recordAudit(tx, actor, { action: "config.activated", target: { type: "config", id: created.id } });
        return getConfig(tx, created.id);
      });
      if (!config) return c.json({ error: "Not found" }, 404);
      const body: PipelineSettings = {
        config: toConfigSummary(config, config.id),
        senderRequire: senderPolicy(config.policy).require,
      };
      return c.json(body, 200);
    });
