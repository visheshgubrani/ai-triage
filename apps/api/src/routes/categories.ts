import {
  type CategoryInfo,
  type CategoryList,
  CategoryNameParam,
  type CategoryPreview,
  type CategorySaved,
  type ErrorResponse,
} from "@ai-triage/contracts";
import {
  activateConfig,
  createCandidateConfig,
  createCategoryVersion,
  displaySchemaOf,
  getActiveConfig,
  getConfig,
  liveWorkers,
  loadSchemaVersions,
  type PipelineConfig,
  recordAudit,
  storedDefinition,
  type TenantTx,
  withTenantTx,
} from "@ai-triage/db";
import {
  CategoryDefinition,
  COMPARATORS,
  compileDefinition,
  DEFINITION_LIMITS,
  FIELD_TYPES,
  requiredFields,
  STARTERS,
  schemaDescription,
  schemaProperties,
} from "@ai-triage/schemas";
import { Hono } from "hono";
import { userActor } from "../audit";
import type { AppDeps } from "../deps";
import { toConfigSummary } from "../evals";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";

// Settings → Categories (docs/architecture.md §4): a tenant's own document types, as data. Saving
// one creates a category version, then a config version with it in which every category is reviewed
// by a person (classify sees every category's description, so old thresholds no longer hold), and
// activates it. Auto-approval comes back through the evals flow, as after a model change.

async function categoryInfos(tx: TenantTx, config: PipelineConfig): Promise<CategoryInfo[]> {
  const versions = await loadSchemaVersions(
    tx,
    config.categories.map((c) => c.schemaVersionId),
  );
  return config.categories
    .map((c): CategoryInfo | null => {
      const row = versions.find((v) => v.id === c.schemaVersionId);
      if (!row) return null;
      const schema = displaySchemaOf(row);
      const required = new Set(requiredFields(schema));
      return {
        category: c.category,
        origin: row.origin,
        version: row.version,
        schemaVersionId: row.id,
        description: schemaDescription(schema),
        fields: Object.keys(schemaProperties(schema)).map((name) => ({ name, required: required.has(name) })),
        automation: c.automation,
        definition: storedDefinition(row),
      };
    })
    .filter((c) => c !== null)
    .sort((a, b) => (a.origin === b.origin ? a.category.localeCompare(b.category) : a.origin === "builtin" ? -1 : 1));
}

/** What saving a category change does that the admin should know before it happens. */
async function changeWarnings(deps: AppDeps, config: PipelineConfig): Promise<string[]> {
  const warnings: string[] = [];
  const automated = config.categories.filter((c) => c.automation !== "review_all").map((c) => c.category);
  if (automated.length > 0) {
    warnings.push(
      `Saving turns auto-approval off for every category (now on for ${automated.join(", ")}). Calibrate again in Evals to turn it back on.`,
    );
  }
  const simulated = config.classifyModel.startsWith("sim:") && config.extractModel.startsWith("sim:");
  const workers = await liveWorkers(deps.db, deps.now());
  if (!simulated && workers.length > 0 && workers.every((w) => w.llmMode === "replay")) {
    warnings.push(
      "The worker runs in replay mode, which serves only recorded requests. A custom category changes every classify request, so documents will fail as cassette_missing. Run the worker with LLM_MODE=live, or choose the simulator model in Settings → Pipeline.",
    );
  }
  return warnings;
}

export const categoryRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), requireRole("admin"), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/", async (c) => {
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<CategoryList | null> => {
        const config = await getActiveConfig(tx);
        if (!config) return null;
        return {
          configId: config.id,
          categories: await categoryInfos(tx, config),
          starters: STARTERS,
          limits: DEFINITION_LIMITS,
          fieldTypes: [...FIELD_TYPES],
          comparators: [...COMPARATORS],
          warnings: await changeWarnings(deps, config),
        };
      });
      if (!body) return c.json({ error: "The workspace has no active pipeline config" } satisfies ErrorResponse, 404);
      return c.json(body, 200);
    })
    // The compiled schema of a draft, or what's wrong with it; nothing is saved.
    .post("/preview", async (c) => {
      const parsed = CategoryDefinition.safeParse(await c.req.json().catch(() => null));
      const body: CategoryPreview = parsed.success
        ? { jsonSchema: compileDefinition(parsed.data), issues: [], warnings: [] }
        : {
            jsonSchema: null,
            issues: parsed.error.issues.map((i) => ({ path: `/${i.path.map(String).join("/")}`, message: i.message })),
            warnings: [],
          };
      return c.json(body, 200);
    })
    // Adds a custom category, or saves a new version of one, and activates the resulting config.
    .post("/", validate("json", CategoryDefinition), async (c) => {
      const definition = c.req.valid("json");
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<CategorySaved | null> => {
        const active = await getActiveConfig(tx);
        if (!active) return null;
        const userId = c.var.tenant.user.id;
        const replacing = active.categories.some((k) => k.category === definition.name);
        const version = await createCategoryVersion(tx, definition, userId);
        const created = await createCandidateConfig(tx, {
          parentId: active.id,
          name: `${replacing ? "Updated" : "Added"} category ${definition.name}`,
          schemaVersions: { [definition.name]: version.id },
          createdBy: userId,
        });
        await activateConfig(tx, created.id);
        const actor = userActor(c, deps);
        await recordAudit(tx, actor, {
          action: "category.version_created",
          target: { type: "category", id: version.id },
          details: { category: version.category, version: version.version, configId: created.id },
        });
        await recordAudit(tx, actor, {
          action: "config.created",
          target: { type: "config", id: created.id },
          details: { parentId: active.id, from: "categories" },
        });
        await recordAudit(tx, actor, { action: "config.activated", target: { type: "config", id: created.id } });
        const config = await getConfig(tx, created.id);
        if (!config) throw new Error("created config not found");
        return { category: version.category, version: version.version, config: toConfigSummary(config, config.id) };
      });
      if (!body) return c.json({ error: "The workspace has no active pipeline config" } satisfies ErrorResponse, 404);
      return c.json(body, 201);
    })
    // Removes a category from the active set (its versions stay, for documents already extracted).
    .delete("/:name", validate("param", CategoryNameParam), async (c) => {
      const { name } = c.req.valid("param");
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx) => {
        const active = await getActiveConfig(tx);
        if (!active?.categories.some((k) => k.category === name)) return null;
        const userId = c.var.tenant.user.id;
        const created = await createCandidateConfig(tx, {
          parentId: active.id,
          name: `Removed category ${name}`,
          schemaVersions: { [name]: null },
          createdBy: userId,
        });
        await activateConfig(tx, created.id);
        const actor = userActor(c, deps);
        await recordAudit(tx, actor, {
          action: "config.created",
          target: { type: "config", id: created.id },
          details: { parentId: active.id, from: "categories", removed: name },
        });
        await recordAudit(tx, actor, { action: "config.activated", target: { type: "config", id: created.id } });
        const config = await getConfig(tx, created.id);
        if (!config) throw new Error("created config not found");
        return { config: toConfigSummary(config, config.id) };
      });
      if (!body) return c.json({ error: "Not found" } satisfies ErrorResponse, 404);
      return c.json(body, 200);
    });
