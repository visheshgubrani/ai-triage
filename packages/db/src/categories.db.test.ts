import { BUILTIN_CATEGORIES } from "@ai-triage/core";
import { BUILTIN_CATEGORY_NAMES, CLASSIFY_PROMPT_FOR_CUSTOM, STARTERS, TEMPLATES } from "@ai-triage/schemas";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ConfigError,
  createCandidateConfig,
  createCategoryVersion,
  createConfigVersion,
  getConfig,
  type PipelineConfig,
  storedDefinition,
} from "./configs";
import { displaySchemaOf } from "./documents";
import { createPool, withTenantTx } from "./index";
import { buildPipelineConfig } from "./pipeline-config";
import { categorySchemaVersions, promptVersions } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { expectPgError, insertConfigFixture, newTenant, PG, testDbUrls } from "./testing";

// Custom categories (docs/architecture.md §4): versions of a tenant's definitions, and the config
// versions that use them.

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

let tenantId: string;
let base: PipelineConfig;
beforeAll(async () => {
  tenantId = await newTenant(app);
  base = await withTenantTx(app, tenantId, (tx) =>
    buildPipelineConfig(tx, { categories: { invoice: { automation: "auto_when_confident" } } }),
  );
});

const inTenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantTx(app, tenantId, fn);
const receipt = STARTERS.find((s) => s.id === "receipt")?.definition;
if (!receipt) throw new Error("receipt starter missing");

async function classifyPromptVersion(tx: TenantTx, config: PipelineConfig) {
  const [row] = await tx.db
    .select({ version: promptVersions.version })
    .from(promptVersions)
    .where(eq(promptVersions.id, config.classifyPromptVersionId));
  return row?.version;
}

describe("built-in names", () => {
  it("are the same closed set in core, schemas and the templates", () => {
    expect([...BUILTIN_CATEGORY_NAMES].sort()).toEqual([...BUILTIN_CATEGORIES].sort());
    expect(Object.keys(TEMPLATES).sort()).toEqual([...BUILTIN_CATEGORIES].sort());
  });
});

describe("category versions", () => {
  it("numbers versions per category, compiles the schema and keeps field order", async () => {
    const [v1, v2] = await inTenant(async (tx) => [
      await createCategoryVersion(tx, receipt),
      await createCategoryVersion(tx, { ...receipt, description: "Proof of a payment already made, v2." }),
    ]);
    expect([v1?.category, v1?.version, v2?.version]).toEqual(["receipt", 1, 2]);
    const row = await inTenant(async (tx) => {
      const [r] = await tx.db
        .select()
        .from(categorySchemaVersions)
        .where(eq(categorySchemaVersions.id, v1?.id ?? ""));
      return r;
    });
    if (!row) throw new Error("version not stored");
    expect(row.origin).toBe("custom");
    expect(storedDefinition(row)?.fields.map((f) => f.name)).toEqual(receipt.fields.map((f) => f.name));
    expect(Object.keys((displaySchemaOf(row).properties ?? {}) as object)).toEqual(receipt.fields.map((f) => f.name));
  });

  it("refuses invalid definitions and built-in names", async () => {
    await expect(inTenant((tx) => createCategoryVersion(tx, { ...receipt, name: "invoice" }))).rejects.toThrow(
      ConfigError,
    );
    await expect(inTenant((tx) => createCategoryVersion(tx, { ...receipt, fields: [] }))).rejects.toThrow(ConfigError);
  });

  it("the database refuses a definition under a built-in name or other, and a builtin with one", async () => {
    for (const category of ["invoice", "other"]) {
      await expectPgError(
        inTenant((tx) =>
          tx.db.insert(categorySchemaVersions).values({
            tenantId,
            category,
            version: 900,
            jsonSchema: {},
            definition: receipt,
            origin: "custom",
          }),
        ),
        PG.checkViolation,
      );
    }
    await expectPgError(
      inTenant((tx) =>
        tx.db
          .insert(categorySchemaVersions)
          .values({ tenantId, category: "receipt", version: 901, jsonSchema: {}, definition: receipt }),
      ),
      PG.checkViolation,
    );
  });
});

describe("config versions with custom categories", () => {
  it("adding one switches classify to prompt v2 and puts every category on review_all", async () => {
    const config = await inTenant(async (tx) => {
      const version = await createCategoryVersion(tx, { ...receipt, name: "receipt_added" });
      return createCandidateConfig(tx, {
        parentId: base.id,
        name: "add",
        schemaVersions: { receipt_added: version.id },
      });
    });
    expect(config.categories.map((c) => c.category).sort()).toEqual([
      "contract",
      "invoice",
      "receipt_added",
      "support_request",
    ]);
    expect(config.categories.every((c) => c.automation === "review_all")).toBe(true);
    expect(await inTenant((tx) => classifyPromptVersion(tx, config))).toBe(CLASSIFY_PROMPT_FOR_CUSTOM.version);
    // The built-in-only parent is untouched and still on v1.
    const parent = await inTenant((tx) => getConfig(tx, base.id));
    expect(await inTenant((tx) => classifyPromptVersion(tx, parent as PipelineConfig))).toBe(1);
  });

  it("replaces a version and removes a category, keeping at least one", async () => {
    const { replaced, removed } = await inTenant(async (tx) => {
      const v1 = await createCategoryVersion(tx, { ...receipt, name: "receipt_swap" });
      const added = await createCandidateConfig(tx, {
        parentId: base.id,
        name: "a",
        schemaVersions: { receipt_swap: v1.id },
      });
      const v2 = await createCategoryVersion(tx, { ...receipt, name: "receipt_swap" });
      const replaced = await createCandidateConfig(tx, {
        parentId: added.id,
        name: "b",
        schemaVersions: { receipt_swap: v2.id },
      });
      const removed = await createCandidateConfig(tx, {
        parentId: replaced.id,
        name: "c",
        schemaVersions: { receipt_swap: null, contract: null },
      });
      return { replaced: { config: replaced, v2 }, removed };
    });
    expect(replaced.config.categories.find((c) => c.category === "receipt_swap")?.schemaVersionId).toBe(replaced.v2.id);
    expect(removed.categories.map((c) => c.category).sort()).toEqual(["invoice", "support_request"]);
    await expect(
      inTenant((tx) =>
        createCandidateConfig(tx, {
          parentId: removed.id,
          name: "none",
          schemaVersions: { invoice: null, support_request: null },
        }),
      ),
    ).rejects.toThrow("at least one category");
    await expect(
      inTenant((tx) => createCandidateConfig(tx, { parentId: removed.id, name: "x", schemaVersions: { nope: null } })),
    ).rejects.toThrow("unknown categories");
  });

  it("refuses a custom category with classify v1, and a prompt of the wrong stage", async () => {
    await inTenant(async (tx) => {
      const fixture = await insertConfigFixture(tx, ["invoice"]);
      const version = await createCategoryVersion(tx, { ...receipt, name: "receipt_v1" });
      const categories = [
        ...fixture.input.categories,
        { category: "receipt_v1", schemaVersionId: version.id, threshold: 0.9 },
      ];
      await expect(createConfigVersion(tx, { ...fixture.input, categories })).rejects.toThrow("classify prompt v2");
      await expect(
        createConfigVersion(tx, {
          ...fixture.input,
          classify: { ...fixture.input.classify, promptVersionId: fixture.extractPrompt.id },
        }),
      ).rejects.toThrow("is a prompt for extract");
    });
  });
});
