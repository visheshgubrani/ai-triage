import { randomUUID } from "node:crypto";
import type { ReviewTaskKind } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { inject } from "vitest";
import { getActiveConfig, type NewConfigVersion } from "./configs";
import { PG, pgCode } from "./errors";
import { createDb } from "./index";
import type { MigrationUrls } from "./migrate";
import {
  applyRouteDecision,
  insertClassification,
  insertModelExtraction,
  setCurrentExtraction,
  upsertOpenTask,
} from "./pipeline";
import { categorySchemaVersions, documents, processingRuns, promptVersions } from "./schema";
import type { TenantTx } from "./tenant-tx";
import { createTenant } from "./tenants";
import { ensurePasswordUser } from "./users";

// Test-only helpers for *.db.test.ts files (exported as @ai-triage/db/testing; never imported by app code).

export { PG, pgCode };

declare module "vitest" {
  export interface ProvidedContext {
    dbUrls: MigrationUrls;
  }
}

/** URLs of the scratch `triage_test` database created by packages/db/test/global-setup.ts. */
export function testDbUrls(): MigrationUrls {
  return inject("dbUrls");
}

/** A fresh tenant with a unique slug, so test files never share rows. */
export async function newTenant(pool: pg.Pool): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const { id } = await createTenant(pool, { name: `Test ${suffix}`, slug: `test-${suffix}` });
  return id;
}

/** A fresh user (no memberships), e.g. as the author of a reviewer's extraction revision. */
export async function testUser(pool: pg.Pool): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  return ensurePasswordUser(createDb(pool), {
    email: `user-${suffix}@test.test`,
    name: `User ${suffix}`,
    password: "test-password",
  });
}

/** Awaits `promise`, expecting it to fail with the given SQLSTATE; returns the error. */
export async function expectPgError(promise: Promise<unknown>, code: string): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    const actual = pgCode(err);
    if (actual !== code) throw new Error(`expected SQLSTATE ${code}, got ${actual ?? "none"}: ${String(err)}`);
    return err;
  }
  throw new Error(`expected SQLSTATE ${code}, but the query succeeded`);
}

/**
 * Inserts prompt versions and one schema version per category for the tenant in `tx`, and returns
 * a config input using them (Opus 5.5 at low effort, review_all). Versions are numbered per call
 * so a test can create several fixtures in one tenant.
 */
export async function insertConfigFixture(tx: TenantTx, categories: string[] = ["invoice"]) {
  const version = Math.floor(Math.random() * 1_000_000);
  const [classifyPrompt, extractPrompt] = await tx.db
    .insert(promptVersions)
    .values([
      { tenantId: tx.tenantId, stage: "classify", version, body: "Classify." },
      { tenantId: tx.tenantId, stage: "extract", version, body: "Extract." },
    ])
    .returning();
  const schemas = await tx.db
    .insert(categorySchemaVersions)
    .values(categories.map((category) => ({ tenantId: tx.tenantId, category, version, jsonSchema: {} })))
    .returning();
  if (!classifyPrompt || !extractPrompt) throw new Error("fixture insert failed");
  const input: NewConfigVersion = {
    name: "test config",
    classify: { model: "claude-opus-5-5", effort: "low", promptVersionId: classifyPrompt.id },
    extract: { model: "claude-opus-5-5", effort: "low", promptVersionId: extractPrompt.id },
    categories: schemas.map((s) => ({ category: s.category, schemaVersionId: s.id, threshold: 0.9 })),
  };
  return { input, schemas, classifyPrompt, extractPrompt };
}

/** Inserts a document for the tenant in `tx`. */
export async function insertDocument(tx: TenantTx, externalId: string = randomUUID()) {
  const [doc] = await tx.db
    .insert(documents)
    .values({ tenantId: tx.tenantId, source: "api", externalId, sourceKey: `t/${tx.tenantId}/test/${externalId}` })
    .returning();
  if (!doc) throw new Error("document insert failed");
  return doc;
}

/** A valid invoice extraction (passes Ajv and the invoice rules). */
export const SAMPLE_INVOICE_FIELDS = {
  vendor_name: "Acme Supplies",
  invoice_number: "INV-1001",
  invoice_date: "2026-10-01",
  currency: "USD",
  subtotal: 100,
  tax: 10,
  total: 110,
  line_items: [{ description: "Paper", amount: 100 }],
};

/**
 * A document that went through the pipeline and is waiting for a human, without running the worker:
 * a finished run, a classification, and (for `review`/`audit`) a model extraction with its route
 * decision, plus the open task. Needs an active config with the built-in categories
 * (buildPipelineConfig).
 */
export async function seedReviewTask(
  tx: TenantTx,
  input: { kind?: ReviewTaskKind; category?: string; fields?: unknown; reasons?: string[]; score?: number } = {},
) {
  const config = await getActiveConfig(tx);
  if (!config) throw new Error("seedReviewTask needs an active config (buildPipelineConfig)");
  const kind = input.kind ?? "review";
  const doc = await insertDocument(tx);
  const failed = kind === "processing_failed";
  const [run] = await tx.db
    .insert(processingRuns)
    .values({
      tenantId: tx.tenantId,
      documentId: doc.id,
      configId: config.id,
      trigger: "ingest",
      status: failed ? "failed" : "done",
      error: failed ? "llm_refusal: test" : null,
      finishedAt: new Date(),
    })
    .returning();
  if (!run) throw new Error("run insert failed");
  await tx.db
    .update(documents)
    .set({ currentRunId: run.id, processingStatus: failed ? "failed" : "done", reviewStatus: "pending" })
    .where(eq(documents.id, doc.id));
  if (failed) {
    const taskId = await upsertOpenTask(tx, { documentId: doc.id, kind, reasons: input.reasons ?? ["llm_refusal"] });
    return { documentId: doc.id, runId: run.id, extractionId: null, taskId };
  }

  const category = kind === "unclassified" ? "other" : (input.category ?? "invoice");
  const score = input.score ?? 0.95;
  await insertClassification(tx, {
    documentId: doc.id,
    runId: run.id,
    category,
    selfConfidence: score,
    rationale: "test",
  });
  if (kind === "unclassified") {
    const taskId = await upsertOpenTask(tx, { documentId: doc.id, kind, reasons: ["category_other"] });
    return { documentId: doc.id, runId: run.id, extractionId: null, taskId };
  }

  const policy = config.categories.find((c) => c.category === category);
  if (!policy) throw new Error(`category ${category} is not in the active config`);
  const extraction = await insertModelExtraction(tx, {
    documentId: doc.id,
    runId: run.id,
    category,
    schemaVersionId: policy.schemaVersionId,
    fields: input.fields ?? SAMPLE_INVOICE_FIELDS,
    validationErrors: [],
  });
  await setCurrentExtraction(tx, doc.id, extraction.id);
  const reasons = input.reasons ?? (kind === "audit" ? ["audit_sample"] : ["automation_off"]);
  await applyRouteDecision(tx, extraction.id, {
    gateResults: { failures: [], evidence: { unverifiable: false, checks: [] }, rules: [] },
    score,
    decision: kind === "audit" ? "auto" : "review",
    reasons,
  });
  const taskId = await upsertOpenTask(tx, { documentId: doc.id, kind, extractionId: extraction.id, reasons });
  return { documentId: doc.id, runId: run.id, extractionId: extraction.id, taskId };
}
