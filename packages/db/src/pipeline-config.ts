import type { AutomationMode, Effort, ModelRef } from "@ai-triage/core";
import { PROMPTS, TEMPLATES, toJsonSchema } from "@ai-triage/schemas";
import { and, eq } from "drizzle-orm";
import { createConfigVersion, ensurePromptVersion, type PipelineConfig, setActiveConfig } from "./configs";
import { categorySchemaVersions } from "./schema";
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
  classify?: { model: ModelRef; effort: Effort };
  extract?: { model: ModelRef; effort: Effort };
  /** Routing per built-in category; anything not listed reviews everything at threshold 0.9. */
  categories?: Partial<Record<string, Partial<CategorySettings>>>;
  createdBy?: string;
}

const DEFAULT_CATEGORY: CategorySettings = { threshold: 0.9, automation: "review_all", auditRate: 0.1 };

/**
 * The model the demo tenant uses for both stages, and so the model the committed cassettes are
 * recorded with (a cassette is keyed by the exact request, model included). The recorder defaults to
 * it, and the replay e2e test uses it. Changing it means re-recording: `pnpm cassettes:record --all`.
 */
export const DEMO_MODEL: { model: ModelRef; effort: Effort } = { model: "openai:gpt-6.1-terra", effort: "low" };

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

  // Pinned to v1: the seeds, the recorder and tenant:create stay built-in only, so their requests
  // match the committed cassettes byte for byte.
  const promptIds = {
    classify: await ensurePromptVersion(tx, "classify", PROMPTS.classify),
    extract: await ensurePromptVersion(tx, "extract", PROMPTS.extract),
  };

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
