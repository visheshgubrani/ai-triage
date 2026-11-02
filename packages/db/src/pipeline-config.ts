import type { AutomationMode, Effort, ModelId } from "@ai-triage/core";
import { PROMPTS, TEMPLATES, toJsonSchema } from "@ai-triage/schemas";
import { and, eq } from "drizzle-orm";
import { createConfigVersion, type PipelineConfig, setActiveConfig } from "./configs";
import { categorySchemaVersions, promptVersions } from "./schema";
import type { TenantTx } from "./tenant-tx";

/** Per-stage limits stored in `pipeline_configs.policy`, so they are versioned with the config. */
export interface StagePolicy {
  classifyMaxTokens: number;
  extractMaxTokens: number;
}

export const DEFAULT_STAGE_POLICY: StagePolicy = { classifyMaxTokens: 4096, extractMaxTokens: 16000 };

export function stagePolicy(policy: unknown): StagePolicy {
  const p = (policy ?? {}) as Partial<StagePolicy>;
  return {
    classifyMaxTokens: p.classifyMaxTokens ?? DEFAULT_STAGE_POLICY.classifyMaxTokens,
    extractMaxTokens: p.extractMaxTokens ?? DEFAULT_STAGE_POLICY.extractMaxTokens,
  };
}

export interface CategorySettings {
  threshold: number;
  automation: AutomationMode;
  auditRate: number;
}

export interface PipelineConfigOptions {
  name?: string;
  classify?: { model: ModelId; effort: Effort };
  extract?: { model: ModelId; effort: Effort };
  /** Routing per built-in category; anything not listed reviews everything at threshold 0.9. */
  categories?: Partial<Record<string, Partial<CategorySettings>>>;
  createdBy?: string;
}

const DEFAULT_CATEGORY: CategorySettings = { threshold: 0.9, automation: "review_all", auditRate: 0.1 };

/** The demo tenant's routing: invoices and support requests may auto-approve; contracts never do. */
export const DEMO_CATEGORY_SETTINGS: Record<string, Partial<CategorySettings>> = {
  invoice: { automation: "auto_when_confident" },
  support_request: { automation: "auto_when_confident" },
  contract: { automation: "review_all" },
};

/**
 * Creates and activates a config version using the built-in category templates and v1 prompts
 * (both get-or-create, since they are immutable versions). Opus 5.5 at low effort by default.
 */
export async function buildPipelineConfig(tx: TenantTx, options: PipelineConfigOptions = {}): Promise<PipelineConfig> {
  const schemaIds: Record<string, string> = {};
  for (const template of Object.values(TEMPLATES)) {
    const where = and(
      eq(categorySchemaVersions.category, template.category),
      eq(categorySchemaVersions.version, template.version),
    );
    const [existing] = await tx.db.select({ id: categorySchemaVersions.id }).from(categorySchemaVersions).where(where);
    const [row] = existing
      ? [existing]
      : await tx.db
          .insert(categorySchemaVersions)
          .values({
            tenantId: tx.tenantId,
            category: template.category,
            version: template.version,
            jsonSchema: toJsonSchema(template),
          })
          .returning({ id: categorySchemaVersions.id });
    if (!row) throw new Error(`schema version insert for ${template.category} returned no row`);
    schemaIds[template.category] = row.id;
  }

  const promptIds = { classify: "", extract: "" };
  for (const stage of ["classify", "extract"] as const) {
    const { version, body } = PROMPTS[stage];
    const where = and(eq(promptVersions.stage, stage), eq(promptVersions.version, version));
    const [existing] = await tx.db.select({ id: promptVersions.id }).from(promptVersions).where(where);
    const [row] = existing
      ? [existing]
      : await tx.db
          .insert(promptVersions)
          .values({ tenantId: tx.tenantId, stage, version, body })
          .returning({ id: promptVersions.id });
    if (!row) throw new Error(`prompt version insert for ${stage} returned no row`);
    promptIds[stage] = row.id;
  }

  const classify = options.classify ?? { model: "claude-opus-5-5", effort: "low" };
  const extract = options.extract ?? { model: "claude-opus-5-5", effort: "low" };
  const config = await createConfigVersion(tx, {
    name: options.name ?? "Built-in categories v1",
    classify: { ...classify, promptVersionId: promptIds.classify },
    extract: { ...extract, promptVersionId: promptIds.extract },
    policy: { ...DEFAULT_STAGE_POLICY },
    categories: Object.entries(schemaIds).map(([category, schemaVersionId]) => ({
      category,
      schemaVersionId,
      ...DEFAULT_CATEGORY,
      ...options.categories?.[category],
    })),
    createdBy: options.createdBy,
  });
  await setActiveConfig(tx, config.id);
  return config;
}
