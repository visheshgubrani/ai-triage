import { QUEUES } from "@ai-triage/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, enqueue, type PgBoss, stageJobId } from "./boss";
import { buildPipelineConfig, createDb, createPool, startRun, withTenantTx } from "./index";
import { createAction } from "./pipeline";
import { reconcileAction, reconcileDocument, staleWork } from "./reconcile";
import { insertDocument, newTenant, seedReviewTask, testDbUrls } from "./testing";

// Self-healing (docs/architecture.md §5): only work no job will pick up again is failed.

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
let boss: PgBoss;
let tenantId: string;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  tenantId = await newTenant(app);
  await withTenantTx(app, tenantId, (tx) => buildPipelineConfig(tx));
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await app.end();
});

const inTenant = <T>(fn: Parameters<typeof withTenantTx<T>>[2]) => withTenantTx(app, tenantId, fn);
const deleteJob = (id: string) => app.query("delete from pgboss.job where id = $1", [id]);

async function newRun() {
  return inTenant(async (tx) => {
    const doc = await insertDocument(tx);
    const config = await tx.db.query.pipelineConfigs.findFirst();
    const runId = await startRun(tx, boss, { documentId: doc.id, configId: config?.id ?? "", trigger: "retry" });
    return { documentId: doc.id, runId };
  });
}

describe("reconcileDocument", () => {
  it("leaves a document whose stage job is still queued", async () => {
    const { documentId } = await newRun();
    expect(await inTenant((tx) => reconcileDocument(tx, documentId))).toBe(false);
  });

  it("fails a document whose stage job is gone into Processing failed, as stalled", async () => {
    const { documentId, runId } = await newRun();
    await deleteJob(stageJobId(runId, "parse"));
    expect(await inTenant((tx) => reconcileDocument(tx, documentId))).toBe(true);
    const [task] = (
      await inTenant((tx) =>
        tx.db.execute(
          `select d.processing_status, t.kind, t.reasons from documents d join review_tasks t on t.document_id = d.id where d.id = '${documentId}'`,
        ),
      )
    ).rows;
    expect(task).toMatchObject({ processing_status: "failed", kind: "processing_failed", reasons: ["stalled"] });
    // Again: the run already failed, so nothing changes.
    expect(await inTenant((tx) => reconcileDocument(tx, documentId))).toBe(false);
  });

  it("leaves a document whose stage job's dead letter is still running", async () => {
    const { documentId, runId } = await newRun();
    const jobId = stageJobId(runId, "parse");
    await app.query("update pgboss.job set state = 'failed' where id = $1", [jobId]);
    await app.query("insert into pgboss.job (name, data, source_id, source_name) values ($1, $2, $3, $4)", [
      QUEUES.failed,
      { tenantId, documentId, runId },
      jobId,
      QUEUES.parse,
    ]);
    expect(await inTenant((tx) => reconcileDocument(tx, documentId))).toBe(false);
  });
});

describe("reconcileAction", () => {
  it("fails a pending action only when no delivery job is left for it", async () => {
    const { documentId, extractionId } = await inTenant((tx) => seedReviewTask(tx));
    const actionId = await inTenant(async (tx) => {
      const id = await createAction(tx, { documentId, extractionId: extractionId ?? "", payload: { a: 1 } });
      await enqueue(boss, tx, QUEUES.deliver, { tenantId, actionId: id }, { id });
      return id;
    });
    expect(await inTenant((tx) => reconcileAction(tx, actionId))).toBe(false);
    await deleteJob(actionId);
    expect(await inTenant((tx) => reconcileAction(tx, actionId))).toBe(true);
    const { rows } = await inTenant((tx) =>
      tx.db.execute(`select status, last_error from actions where id = '${actionId}'`),
    );
    expect(rows[0]).toMatchObject({ status: "failed" });
    expect(String(rows[0]?.last_error)).toMatch(/^delivery_stalled/);
  });
});

describe("stale_work()", () => {
  it("lists old in-flight work across tenants, ids only", async () => {
    const { documentId } = await newRun();
    const later = new Date(Date.now() + 60_000);
    const work = await staleWork(createDb(app), later, 10_000);
    expect(work).toContainEqual({ kind: "document", tenantId, id: documentId });
    expect(await staleWork(createDb(app), new Date(0))).toEqual([]);
  });
});
