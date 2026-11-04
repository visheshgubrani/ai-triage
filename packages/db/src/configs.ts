import { type AutomationMode, type Effort, isModelRef, type ModelRef, modelInfo } from "@ai-triage/core";
import {
  CategoryDefinition,
  type CategoryDefinitionInput,
  CLASSIFY_PROMPT_FOR_CUSTOM,
  compileDefinition,
  DEFINITION_LIMITS,
} from "@ai-triage/schemas";
import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import {
  categorySchemaVersions,
  pipelineConfigCategories,
  pipelineConfigs,
  promptVersions,
  tenantSettings,
} from "./schema";
import type { TenantTx } from "./tenant-tx";

// Pipeline configs are immutable versions (triggers in 0002_rls.sql). Changing anything means
// creating a new version; the tenant points at one active version through tenant_settings.

export interface StageConfig {
  model: ModelRef;
  effort: Effort;
  promptVersionId: string;
}

export interface CategoryPolicy {
  category: string;
  schemaVersionId: string;
  threshold: number;
  automation?: AutomationMode;
  auditRate?: number;
}

export interface NewConfigVersion {
  name: string;
  parentId?: string;
  classify: StageConfig;
  extract: StageConfig;
  policy?: Record<string, unknown>;
  categories: CategoryPolicy[];
  createdBy?: string;
}

export type PipelineConfig = typeof pipelineConfigs.$inferSelect & {
  categories: (typeof pipelineConfigCategories.$inferSelect)[];
};

export class ConfigError extends Error {}

function assertStage(stage: string, { model, effort }: StageConfig) {
  if (!isModelRef(model)) throw new ConfigError(`${stage}: unknown model "${model}"`);
  const { efforts } = modelInfo(model);
  if (!efforts.includes(effort)) {
    throw new ConfigError(`${stage}: ${model} accepts effort ${efforts.join(", ")}, not "${effort}"`);
  }
}

type PromptStage = "classify" | "extract";

/** The tenant's prompt row for (stage, version), created from the code's body the first time. */
export async function ensurePromptVersion(
  tx: TenantTx,
  stage: PromptStage,
  prompt: { version: number; body: string },
): Promise<string> {
  const where = and(eq(promptVersions.stage, stage), eq(promptVersions.version, prompt.version));
  const [existing] = await tx.db.select({ id: promptVersions.id }).from(promptVersions).where(where);
  if (existing) return existing.id;
  const [row] = await tx.db
    .insert(promptVersions)
    .values({ tenantId: tx.tenantId, stage, version: prompt.version, body: prompt.body })
    .returning({ id: promptVersions.id });
  if (!row) throw new Error(`prompt version insert for ${stage} returned no row`);
  return row.id;
}

/**
 * Prompts must match their stage, and a config with any custom category classifies with prompt v2:
 * v1's examples name only the built-ins. Built-in-only configs keep whatever they had, so their
 * requests (and the recorded cassettes) never change.
 */
async function assertPrompts(tx: TenantTx, input: NewConfigVersion) {
  const ids = [input.classify.promptVersionId, input.extract.promptVersionId];
  const rows = await tx.db
    .select({ id: promptVersions.id, stage: promptVersions.stage, version: promptVersions.version })
    .from(promptVersions)
    .where(inArray(promptVersions.id, ids));
  const prompt = (stage: PromptStage, id: string) => {
    const row = rows.find((r) => r.id === id);
    if (!row) throw new ConfigError(`${stage}: prompt version ${id} not found`);
    if (row.stage !== stage) throw new ConfigError(`${stage}: prompt version ${id} is a prompt for ${row.stage}`);
    return row;
  };
  const classify = prompt("classify", input.classify.promptVersionId);
  prompt("extract", input.extract.promptVersionId);

  const schemas = await tx.db
    .select({ category: categorySchemaVersions.category, origin: categorySchemaVersions.origin })
    .from(categorySchemaVersions)
    .where(
      inArray(
        categorySchemaVersions.id,
        input.categories.map((c) => c.schemaVersionId),
      ),
    );
  const custom = schemas.filter((s) => s.origin === "custom");
  if (custom.length > 0 && classify.version !== CLASSIFY_PROMPT_FOR_CUSTOM.version) {
    throw new ConfigError(
      `custom categories (${custom.map((s) => s.category).join(", ")}) need classify prompt v${CLASSIFY_PROMPT_FOR_CUSTOM.version}`,
    );
  }
}

/** Inserts the next config version (max + 1 for the tenant) with its category policies. */
export async function createConfigVersion(tx: TenantTx, input: NewConfigVersion): Promise<PipelineConfig> {
  assertStage("classify", input.classify);
  assertStage("extract", input.extract);
  if (input.categories.length === 0) throw new ConfigError("a config needs at least one category");
  if (input.categories.length > DEFINITION_LIMITS.categoriesPerTenant) {
    throw new ConfigError(`a config has at most ${DEFINITION_LIMITS.categoriesPerTenant} categories`);
  }
  await assertPrompts(tx, input);

  const [latest] = await tx.db.select({ version: max(pipelineConfigs.version) }).from(pipelineConfigs);
  const [config] = await tx.db
    .insert(pipelineConfigs)
    .values({
      tenantId: tx.tenantId,
      version: (latest?.version ?? 0) + 1,
      parentId: input.parentId,
      name: input.name,
      classifyModel: input.classify.model,
      classifyEffort: input.classify.effort,
      classifyPromptVersionId: input.classify.promptVersionId,
      extractModel: input.extract.model,
      extractEffort: input.extract.effort,
      extractPromptVersionId: input.extract.promptVersionId,
      policy: input.policy ?? {},
      createdBy: input.createdBy,
    })
    .returning();
  if (!config) throw new ConfigError("config insert returned no row");

  const categories = await tx.db
    .insert(pipelineConfigCategories)
    .values(input.categories.map((c) => ({ tenantId: tx.tenantId, configId: config.id, ...c })))
    .returning();
  return { ...config, categories };
}

/** Freezes a config once it has been calibrated. Throws if it is missing or already frozen. */
export async function freezeConfig(tx: TenantTx, configId: string): Promise<Date> {
  const [row] = await tx.db
    .update(pipelineConfigs)
    .set({ frozenAt: new Date() })
    .where(and(eq(pipelineConfigs.id, configId), isNull(pipelineConfigs.frozenAt)))
    .returning({ frozenAt: pipelineConfigs.frozenAt });
  if (!row?.frozenAt) throw new ConfigError(`config ${configId} not found or already frozen`);
  return row.frozenAt;
}

export async function setActiveConfig(tx: TenantTx, configId: string): Promise<void> {
  await tx.db
    .insert(tenantSettings)
    .values({ tenantId: tx.tenantId, activeConfigId: configId })
    .onConflictDoUpdate({ target: tenantSettings.tenantId, set: { activeConfigId: configId } });
}

export async function getActiveConfig(tx: TenantTx): Promise<PipelineConfig | null> {
  const [settings] = await tx.db.select({ configId: tenantSettings.activeConfigId }).from(tenantSettings);
  if (!settings?.configId) return null;
  return getConfig(tx, settings.configId);
}

export async function getConfig(tx: TenantTx, configId: string): Promise<PipelineConfig | null> {
  const [config] = await tx.db.select().from(pipelineConfigs).where(eq(pipelineConfigs.id, configId));
  if (!config) return null;
  const categories = await tx.db
    .select()
    .from(pipelineConfigCategories)
    .where(eq(pipelineConfigCategories.configId, configId));
  return { ...config, categories };
}

/** A category's routing settings in a candidate version. */
export interface CategoryChange {
  category: string;
  threshold: number;
  automation: AutomationMode;
  auditRate: number;
}

export interface CandidateConfig {
  /** The version this one starts from: everything not overridden is copied, `policy` verbatim. */
  parentId: string;
  name: string;
  classify?: Partial<StageConfig>;
  extract?: Partial<StageConfig>;
  /** Categories not listed keep the parent's settings. */
  categories?: CategoryChange[];
  /**
   * Changes to the category set: a schema version id adds the category or replaces its version,
   * null removes it. Any change puts every category on review_all, because classify sees every
   * category's description: thresholds calibrated for the old set mean nothing for the new one.
   */
  schemaVersions?: Record<string, string | null>;
  /** Replaces the parent's sender policy (`policy.sender`, see senderPolicy() in core). */
  sender?: { require: boolean; trustedAuthServIds: string[]; mailbox?: { require: boolean } };
  createdBy?: string;
}

/** A new (unfrozen, inactive) version derived from another: the evals page's way to try a change. */
export async function createCandidateConfig(tx: TenantTx, input: CandidateConfig): Promise<PipelineConfig> {
  const parent = await getConfig(tx, input.parentId);
  if (!parent) throw new ConfigError(`config ${input.parentId} not found`);
  const unknown = (input.categories ?? []).filter((c) => !parent.categories.some((p) => p.category === c.category));
  if (unknown.length > 0) throw new ConfigError(`unknown categories: ${unknown.map((c) => c.category).join(", ")}`);

  const setChanges = Object.entries(input.schemaVersions ?? {});
  const removed = setChanges.filter(([, id]) => id === null).map(([category]) => category);
  const missing = removed.filter((category) => !parent.categories.some((p) => p.category === category));
  if (missing.length > 0) throw new ConfigError(`unknown categories: ${missing.join(", ")}`);
  const reset = setChanges.length > 0;

  const kept = parent.categories
    .filter((p) => !removed.includes(p.category))
    .map((p) => {
      const change = input.categories?.find((c) => c.category === p.category);
      return {
        category: p.category,
        schemaVersionId: input.schemaVersions?.[p.category] ?? p.schemaVersionId,
        threshold: change?.threshold ?? Number(p.threshold),
        automation: reset ? ("review_all" as const) : (change?.automation ?? p.automation),
        auditRate: change?.auditRate ?? Number(p.auditRate),
      };
    });
  const added = setChanges
    .filter(([category, id]) => id !== null && !parent.categories.some((p) => p.category === category))
    .map(([category, id]) => ({
      category,
      schemaVersionId: id as string,
      threshold: 0.9,
      automation: "review_all" as const,
      auditRate: 0.1,
    }));
  const categories = [...kept, ...added];

  // A category set with a custom category classifies with v2; a set back to built-ins only keeps
  // what it had (v2 still works for it), unless the caller picks a prompt.
  let classifyPromptId = input.classify?.promptVersionId ?? parent.classifyPromptVersionId;
  if (reset && !input.classify?.promptVersionId) {
    const origins = await tx.db
      .select({ origin: categorySchemaVersions.origin })
      .from(categorySchemaVersions)
      .where(
        inArray(
          categorySchemaVersions.id,
          categories.map((c) => c.schemaVersionId),
        ),
      );
    if (origins.some((o) => o.origin === "custom")) {
      classifyPromptId = await ensurePromptVersion(tx, "classify", CLASSIFY_PROMPT_FOR_CUSTOM);
    }
  }

  return createConfigVersion(tx, {
    name: input.name,
    parentId: parent.id,
    classify: {
      model: input.classify?.model ?? (parent.classifyModel as ModelRef),
      effort: input.classify?.effort ?? (parent.classifyEffort as Effort),
      promptVersionId: classifyPromptId,
    },
    extract: {
      model: input.extract?.model ?? (parent.extractModel as ModelRef),
      effort: input.extract?.effort ?? (parent.extractEffort as Effort),
      promptVersionId: input.extract?.promptVersionId ?? parent.extractPromptVersionId,
    },
    policy: {
      ...(parent.policy as Record<string, unknown>),
      ...(input.sender
        ? {
            sender: {
              ...input.sender,
              trustedAuthServIds: input.sender.trustedAuthServIds.map((s) => s.toLowerCase()),
            },
          }
        : {}),
    },
    categories,
    createdBy: input.createdBy,
  });
}

export interface CategoryVersion {
  id: string;
  category: string;
  version: number;
}

/**
 * Inserts the next version of a custom category from its definition (validated here, so a stored
 * definition always parses). Versions are insert-only; a config points at one.
 */
export async function createCategoryVersion(
  tx: TenantTx,
  input: CategoryDefinitionInput,
  createdBy?: string,
): Promise<CategoryVersion> {
  const parsed = CategoryDefinition.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "definition"}: ${i.message}`).join("; "),
    );
  }
  const definition = parsed.data;
  const [latest] = await tx.db
    .select({ version: max(categorySchemaVersions.version) })
    .from(categorySchemaVersions)
    .where(eq(categorySchemaVersions.category, definition.name));
  const [row] = await tx.db
    .insert(categorySchemaVersions)
    .values({
      tenantId: tx.tenantId,
      category: definition.name,
      version: (latest?.version ?? 0) + 1,
      jsonSchema: compileDefinition(definition),
      definition,
      origin: "custom",
      createdBy,
    })
    .returning({
      id: categorySchemaVersions.id,
      category: categorySchemaVersions.category,
      version: categorySchemaVersions.version,
    });
  if (!row) throw new ConfigError("category version insert returned no row");
  return row;
}

/** The stored definition of a schema version, or null for a built-in. */
export function storedDefinition(row: { definition: unknown }): CategoryDefinition | null {
  return row.definition ? CategoryDefinition.parse(row.definition) : null;
}

export interface ConfigListEntry extends PipelineConfig {
  active: boolean;
}

/** Every version, newest first, with its categories and whether it is the tenant's active one. */
export async function listConfigs(tx: TenantTx): Promise<ConfigListEntry[]> {
  const [settings] = await tx.db.select({ configId: tenantSettings.activeConfigId }).from(tenantSettings);
  const configs = await tx.db.select().from(pipelineConfigs).orderBy(desc(pipelineConfigs.version));
  const categories =
    configs.length === 0
      ? []
      : await tx.db
          .select()
          .from(pipelineConfigCategories)
          .where(
            inArray(
              pipelineConfigCategories.configId,
              configs.map((c) => c.id),
            ),
          )
          .orderBy(asc(pipelineConfigCategories.category));
  return configs.map((c) => ({
    ...c,
    categories: categories.filter((k) => k.configId === c.id),
    active: c.id === settings?.configId,
  }));
}

export async function listPromptVersions(tx: TenantTx) {
  return tx.db
    .select({
      id: promptVersions.id,
      stage: promptVersions.stage,
      version: promptVersions.version,
      createdAt: promptVersions.createdAt,
    })
    .from(promptVersions)
    .orderBy(asc(promptVersions.stage), desc(promptVersions.version));
}
