import { QUEUE_OPTIONS, QUEUES } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBoss, enqueue, type PgBoss } from "./boss";
import { createPool, withTenantTx } from "./index";
import { documents } from "./schema";
import { insertDocument, newTenant, testDbUrls } from "./testing";

// Invariant 3: a stage's writes and the next job commit or roll back together, because pg-boss
// sends through the tenant transaction's client.

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
let boss: PgBoss;
let tenantId: string;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  tenantId = await newTenant(app);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await app.end();
});

describe("withTenantTx + pg-boss", () => {
  it("commits the row and the job together", async () => {
    const { documentId, jobId } = await withTenantTx(app, tenantId, async (tx) => {
      const doc = await insertDocument(tx);
      const jobId = await enqueue(boss, tx, QUEUES.parse, { tenantId, documentId: doc.id });
      return { documentId: doc.id, jobId };
    });
    expect(jobId).toBeTruthy();
    expect(await boss.getJobById(QUEUES.parse, jobId ?? "")).toMatchObject({ data: { documentId } });
  });

  it("rolls back the row and the job together", async () => {
    let jobId: string | null = null;
    let documentId = "";
    await expect(
      withTenantTx(app, tenantId, async (tx) => {
        documentId = (await insertDocument(tx)).id;
        jobId = await enqueue(boss, tx, QUEUES.parse, { tenantId, documentId });
        throw new Error("crash before commit");
      }),
    ).rejects.toThrow("crash before commit");

    expect(jobId).toBeTruthy();
    expect(await boss.getJobById(QUEUES.parse, jobId ?? "")).toBeNull();
    const rows = await withTenantTx(app, tenantId, ({ db }) =>
      db.select().from(documents).where(eq(documents.id, documentId)),
    );
    expect(rows).toEqual([]);
  });
});

describe("queue options", () => {
  it("applies QUEUE_OPTIONS: stage queues dead-letter into doc.failed, deliveries into action.failed", async () => {
    for (const name of [QUEUES.parse, QUEUES.classify, QUEUES.extract, QUEUES.route]) {
      expect(await boss.getQueue(name)).toMatchObject({
        retryLimit: QUEUE_OPTIONS[name].retryLimit,
        expireInSeconds: QUEUE_OPTIONS[name].expireInSeconds,
        deadLetter: QUEUES.failed,
      });
    }
    expect(await boss.getQueue(QUEUES.deliver)).toMatchObject({
      retryLimit: QUEUE_OPTIONS[QUEUES.deliver].retryLimit,
      deadLetter: QUEUES.deliveryFailed,
    });
    expect((await boss.getQueue(QUEUES.deliveryFailed))?.deadLetter ?? null).toBeNull();
  });
});

describe("mailbox sync queue", () => {
  it("is exclusive: a second sync of the same mailbox isn't queued while one is pending", async () => {
    expect(await boss.getQueue(QUEUES.mailboxSync)).toMatchObject({ policy: "exclusive" });
    const job = { tenantId, connectionId: crypto.randomUUID() };
    const first = await boss.send(QUEUES.mailboxSync, job, { singletonKey: job.connectionId });
    const second = await boss.send(QUEUES.mailboxSync, job, { singletonKey: job.connectionId });
    const other = await boss.send(QUEUES.mailboxSync, job, { singletonKey: crypto.randomUUID() });
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(other).toBeTruthy();
    await boss.deleteJob(QUEUES.mailboxSync, [first ?? "", other ?? ""]);
  });

  it("dead-letters fetches into mailbox.failed", async () => {
    expect(await boss.getQueue(QUEUES.mailboxFetch)).toMatchObject({ deadLetter: QUEUES.mailboxFailed });
  });
});
