import { QUEUES } from "@ai-triage/core";
import { approvedPayload, proposeAction } from "@ai-triage/core/pipeline";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, type PgBoss } from "./boss";
import { createPool, withTenantTx } from "./index";
import { createAction } from "./pipeline";
import { buildPipelineConfig } from "./pipeline-config";
import { getRetentionDays, listExpiredDocuments, purgeDocument, setRetentionDays, storageToDelete } from "./purge";
import { setReviewOutcome } from "./review";
import { documents, extractions, llmCalls, reviewDecisions } from "./schema";
import { deleteTenantData } from "./tenants";
import { expectPgError, newTenant, PG, SAMPLE_INVOICE_FIELDS, seedReviewTask, testDbUrls, testUser } from "./testing";

// Deletion (0016_purge.sql): one narrow door past the immutability guards, inside the caller's tenant.

const { appUrl, ownerUrl } = testDbUrls();
const app = createPool(appUrl);
const owner = createPool(ownerUrl);
let boss: PgBoss;
beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await Promise.all([app.end(), owner.end()]);
});

/** A decided document with an extraction, a review decision and an action. */
async function decidedDocument(tenantId: string) {
  return withTenantTx(app, tenantId, async (tx) => {
    await buildPipelineConfig(tx);
    const task = await seedReviewTask(tx);
    const extractionId = task.extractionId ?? "";
    const reviewer = await testUser(app);
    await tx.db.insert(reviewDecisions).values({
      tenantId,
      reviewTaskId: task.taskId,
      documentId: task.documentId,
      taskKind: "review",
      extractionId,
      reviewerId: reviewer,
      outcome: "approve",
    });
    const payload = approvedPayload(
      proposeAction({ documentId: task.documentId, extractionId, category: "invoice", values: SAMPLE_INVOICE_FIELDS }),
      "auto",
      new Date(),
    );
    await createAction(tx, { documentId: task.documentId, extractionId, payload });
    await setReviewOutcome(tx, task.documentId, { reviewStatus: "approved", deliveryStatus: "pending" });
    await tx.db.update(documents).set({ deliveryStatus: "delivered" }).where(eq(documents.id, task.documentId));
    return task.documentId;
  });
}

const count = (tenantId: string, table: string, documentId: string) =>
  withTenantTx(app, tenantId, async (tx) => {
    const { rows } = await tx.db.execute<{ n: string }>(
      sql`select count(*) as n from ${sql.identifier(table)} where document_id = ${documentId}`,
    );
    return Number(rows[0]?.n ?? 0);
  });

describe("purgeDocument", () => {
  it("removes the document and everything derived from it, and queues its objects", async () => {
    const tenantId = await newTenant(app);
    const documentId = await decidedDocument(tenantId);
    const purged = await withTenantTx(app, tenantId, (tx) => purgeDocument(tx, boss, documentId));
    expect(purged?.externalIdSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const table of [
      "actions",
      "review_decisions",
      "review_tasks",
      "extractions",
      "classifications",
      "processing_runs",
      "document_parts",
    ]) {
      expect(await count(tenantId, table, documentId), table).toBe(0);
    }
    const left = await withTenantTx(app, tenantId, (tx) =>
      tx.db.select().from(documents).where(eq(documents.id, documentId)),
    );
    expect(left).toHaveLength(0);
    const calls = await withTenantTx(app, tenantId, (tx) => tx.db.select().from(llmCalls));
    expect(calls).toHaveLength(0);
    const jobs = await boss.findJobs(QUEUES.storageDelete, { data: { tenantId } });
    expect(jobs).toHaveLength(1);
  });

  it("keeps the immutability guards for the app role", async () => {
    const tenantId = await newTenant(app);
    await decidedDocument(tenantId);
    await expectPgError(
      withTenantTx(app, tenantId, (tx) => tx.db.delete(extractions)),
      PG.integrityViolation,
    );
  });

  it("can't reach another tenant's document", async () => {
    const tenantA = await newTenant(app);
    const tenantB = await newTenant(app);
    const documentId = await decidedDocument(tenantA);
    expect(await withTenantTx(app, tenantB, (tx) => purgeDocument(tx, boss, documentId))).toBeNull();
    expect(await count(tenantA, "extractions", documentId)).toBe(1);
  });

  it("names an email's folder, or a file's objects, for storage deletion", () => {
    expect(
      storageToDelete("t1", {
        source_key: "t/t1/e/abc/email.json",
        source_mime: "application/vnd.ai-triage.email+json",
        part_keys: [],
      }),
    ).toMatchObject({ prefixes: ["t/t1/e/abc/"], keys: [] });
    expect(
      storageToDelete("t1", { source_key: "t/t1/a/x", source_mime: "application/pdf", part_keys: ["t/t1/a/x"] }),
    ).toMatchObject({
      keys: ["t/t1/a/x"],
      prefixes: [],
    });
  });
});

describe("retention", () => {
  it("lists only finished documents older than the cutoff", async () => {
    const tenantId = await newTenant(app);
    const done = await decidedDocument(tenantId);
    const pending = await withTenantTx(app, tenantId, async (tx) => (await seedReviewTask(tx)).documentId);
    await withTenantTx(app, tenantId, (tx) => setRetentionDays(tx, 30));
    expect(await withTenantTx(app, tenantId, getRetentionDays)).toBe(30);
    const future = new Date(Date.now() + 60_000);
    const expired = await withTenantTx(app, tenantId, (tx) => listExpiredDocuments(tx, future, 10));
    expect(expired).toContain(done);
    expect(expired).not.toContain(pending);
    expect(await withTenantTx(app, tenantId, (tx) => listExpiredDocuments(tx, new Date(0), 10))).toEqual([]);
  });
});

describe("deleteTenantData", () => {
  it("removes a tenant and everything it owns", async () => {
    const tenantId = await newTenant(app);
    await decidedDocument(tenantId);
    const counts = await deleteTenantData(owner, tenantId);
    expect(counts.documents).toBe(1);
    const { rows } = await owner.query("select 1 from tenants where id = $1", [tenantId]);
    expect(rows).toHaveLength(0);
  });
});
