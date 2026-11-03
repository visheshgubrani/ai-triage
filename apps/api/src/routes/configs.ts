import { CandidateConfigRequest, type ConfigList, type ConfigResponse } from "@ai-triage/contracts";
import {
  activateConfig,
  createCandidateConfig,
  getConfig,
  listConfigs,
  listPromptVersions,
  withTenantTx,
} from "@ai-triage/db";
import { Hono } from "hono";
import type { AppDeps } from "../deps";
import { toConfigSummary } from "../evals";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

/**
 * Pipeline config versions (immutable). Admins derive candidates to evaluate and activate frozen
 * ones; freezing happens from a calib run (POST /evals/runs/:id/freeze).
 */
export const configRoutes = (deps: AppDeps) => {
  const admin = requireRole("admin");
  return new Hono<TenantEnv>()
    .use(requireTenant(deps.db, deps.auth))
    .get("/", async (c) => {
      const body: ConfigList = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => ({
        configs: (await listConfigs(tx)).map((config) => toConfigSummary(config)),
        promptVersions: await listPromptVersions(tx),
      }));
      return c.json(body, 200);
    })
    .post("/", admin, validate("json", CandidateConfigRequest), async (c) => {
      const input = c.req.valid("json");
      const config = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        createCandidateConfig(tx, {
          ...input,
          classify: input.classify as Parameters<typeof createCandidateConfig>[1]["classify"],
          extract: input.extract as Parameters<typeof createCandidateConfig>[1]["extract"],
          createdBy: c.var.tenant.user.id,
        }),
      );
      const body: ConfigResponse = { config: toConfigSummary(config) };
      return c.json(body, 201);
    })
    .post("/:id/activate", admin, idParam, async (c) => {
      const id = c.req.valid("param").id;
      const config = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        await activateConfig(tx, id);
        return getConfig(tx, id);
      });
      if (!config) return c.json({ error: "Not found" }, 404);
      const body: ConfigResponse = { config: toConfigSummary(config, config.id) };
      return c.json(body, 200);
    });
};
