import { QUEUES } from "@ai-triage/core";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyRouteDecision,
  buildPipelineConfig,
  claimNext,
  claimTask,
  createAction,
  createBoss,
  createPool,
  encryptLegacyWebhookSecrets,
  getWebhookSettings,
  heartbeat,
  inboxCounts,
  insertDecision,
  keyRingFromEnv,
  listInbox,
  lockTaskForDecision,
  markDeliveryFailed,
  type PgBoss,
  ReviewError,
  releaseClaim,
  requeueAction,
  rotateWebhookSecret,
  setWebhook,
  stageJobId,
  startRun,
  webhookTarget,
  withTenantTx,
} from "./index";
import {
  actions,
  documents,
  extractions,
  processingRuns,
  reviewDecisions,
  reviewTasks,
  tenantSettings,
} from "./schema";
import type { TenantTx } from "./tenant-tx";
import { expectPgError, newTenant, PG, seedReviewTask, testDbUrls, testUser } from "./testing";

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
const KEYS = keyRingFromEnv({});
let boss: PgBoss;
let alice: string;
let bob: string;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  [alice, bob] = await Promise.all([testUser(app), testUser(app)]);
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await app.end();
});

const NOW = new Date("2026-11-03T12:00:00Z");
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

async function tenantWithConfig(): Promise<string> {
  const tenantId = await newTenant(app);
  await withTenantTx(app, tenantId, (tx) => buildPipelineConfig(tx));
  return tenantId;
}

const inTenant = <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => withTenantTx(app, tenantId, fn);

async function reviewError(promise: Promise<unknown>): Promise<ReviewError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ReviewError) return err;
    throw err;
  }
  throw new Error("expected a ReviewError");
}

describe("claims", () => {
  it("hands 10 concurrent reviewers 3 tasks: 3 distinct claims, 7 empty results", async () => {
    const tenantId = await tenantWithConfig();
    for (let i = 0; i < 3; i++) await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const users = await Promise.all(Array.from({ length: 10 }, () => testUser(app)));
    const claims = await Promise.all(
      users.map((userId) => inTenant(tenantId, (tx) => claimNext(tx, { userId, now: NOW }))),
    );
    const won = claims.filter((c) => c !== null);
    expect(won).toHaveLength(3);
    expect(new Set(won.map((c) => c.taskId)).size).toBe(3);
  });

  it("treats a lapsed lease as no claim, and only the holder can extend or release a live one", async () => {
    const tenantId = await tenantWithConfig();
    const { taskId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const mine = await inTenant(tenantId, (tx) => claimTask(tx, { taskId, userId: alice, now: NOW }));
    expect(mine?.leaseExpiresAt).toEqual(later(600));

    // Opening it again keeps the token; another reviewer is turned away while the lease lives.
    const again = await inTenant(tenantId, (tx) => claimTask(tx, { taskId, userId: alice, now: later(60) }));
    expect(again?.claimToken).toBe(mine?.claimToken);
    const busy = await reviewError(inTenant(tenantId, (tx) => claimTask(tx, { taskId, userId: bob, now: later(60) })));
    expect(busy.code).toBe("claimed_by_other");
    expect(await inTenant(tenantId, (tx) => claimNext(tx, { userId: bob, now: later(60) }))).toBeNull();

    const wrongToken = { taskId, userId: alice, claimToken: crypto.randomUUID(), now: later(60) };
    expect((await reviewError(inTenant(tenantId, (tx) => heartbeat(tx, wrongToken)))).code).toBe("claim_lost");
    const token = mine?.claimToken ?? "";
    expect(
      await inTenant(tenantId, (tx) => heartbeat(tx, { taskId, userId: alice, claimToken: token, now: later(60) })),
    ).toEqual(later(660));

    // After the lease lapses, the inbox shows the task as free and someone else may take it.
    const [row] = await inTenant(tenantId, (tx) => listInbox(tx, { now: later(700) }));
    expect(row).toMatchObject({ id: taskId, status: "pending", claim: null });
    const lapsedHeartbeat = { taskId, userId: alice, claimToken: token, now: later(700) };
    expect((await reviewError(inTenant(tenantId, (tx) => heartbeat(tx, lapsedHeartbeat)))).code).toBe("claim_lost");
    const taken = await inTenant(tenantId, (tx) => claimNext(tx, { userId: bob, now: later(700) }));
    expect(taken?.taskId).toBe(taskId);
    expect(taken?.claimToken).not.toBe(token);

    const release = { taskId, userId: bob, claimToken: taken?.claimToken ?? "", now: later(701) };
    expect(await inTenant(tenantId, (tx) => releaseClaim(tx, release))).toBe(true);
    expect(await inTenant(tenantId, (tx) => releaseClaim(tx, release))).toBe(false);
  });

  it("requires a live claim with the right token to decide", async () => {
    const tenantId = await tenantWithConfig();
    const { taskId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const claim = await inTenant(tenantId, (tx) => claimTask(tx, { taskId, userId: alice, now: NOW }));
    const input = { taskId, userId: alice, claimToken: claim?.claimToken ?? "", now: later(30) };
    const locked = await inTenant(tenantId, (tx) => lockTaskForDecision(tx, input));
    expect(locked?.task.id).toBe(taskId);
    for (const bad of [
      { ...input, claimToken: crypto.randomUUID() },
      { ...input, userId: bob },
      { ...input, now: later(601) },
    ]) {
      expect((await reviewError(inTenant(tenantId, (tx) => lockTaskForDecision(tx, bad)))).code).toBe("claim_lost");
    }
    expect(await inTenant(tenantId, (tx) => lockTaskForDecision(tx, { ...input, taskId: crypto.randomUUID() }))).toBe(
      null,
    );
  });

  it("rejects a half-set claim", async () => {
    const tenantId = await tenantWithConfig();
    const { taskId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    await expectPgError(
      inTenant(tenantId, ({ db }) =>
        db.update(reviewTasks).set({ claimedBy: alice }).where(eq(reviewTasks.id, taskId)),
      ),
      PG.checkViolation,
    );
  });
});

describe("inbox", () => {
  it("filters and counts open tasks by kind, category and reason code", async () => {
    const tenantId = await tenantWithConfig();
    await inTenant(tenantId, async (tx) => {
      await seedReviewTask(tx, { reasons: ["required_missing:total", "below_threshold"] });
      await seedReviewTask(tx, { kind: "audit", category: "support_request", fields: {} });
      await seedReviewTask(tx, { kind: "unclassified" });
      await seedReviewTask(tx, { kind: "processing_failed" });
    });
    const counts = await inTenant(tenantId, inboxCounts);
    expect(counts).toEqual({
      total: 4,
      kind: { review: 1, audit: 1, unclassified: 1, processing_failed: 1 },
      category: { invoice: 1, support_request: 1, other: 1 },
      reason: { required_missing: 1, below_threshold: 1, audit_sample: 1, category_other: 1, llm_refusal: 1 },
    });
    const byReason = await inTenant(tenantId, (tx) =>
      listInbox(tx, { now: NOW, filter: { reasonCode: "required_missing" } }),
    );
    expect(byReason.map((r) => r.category)).toEqual(["invoice"]);
    const failed = await inTenant(tenantId, (tx) => listInbox(tx, { now: NOW, filter: { kind: "processing_failed" } }));
    expect(failed[0]?.runError).toBe("llm_refusal: test");
    const support = await inTenant(tenantId, (tx) =>
      listInbox(tx, { now: NOW, filter: { category: "support_request" } }),
    );
    expect(support.map((r) => r.kind)).toEqual(["audit"]);
  });
});

describe("startRun", () => {
  it("retries a failed run from parse and reclassifies a finished one at extract", async () => {
    const tenantId = await tenantWithConfig();
    const failed = await inTenant(tenantId, (tx) => seedReviewTask(tx, { kind: "processing_failed" }));
    const done = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const configId = await inTenant(tenantId, async ({ db }) => {
      const [run] = await db.select().from(processingRuns).where(eq(processingRuns.id, done.runId));
      return run?.configId ?? "";
    });

    const retryId = await inTenant(tenantId, (tx) =>
      startRun(tx, boss, { documentId: failed.documentId, configId, trigger: "retry" }),
    );
    const reclassifyId = await inTenant(tenantId, (tx) =>
      startRun(tx, boss, { documentId: done.documentId, configId, trigger: "reclassify", forcedCategory: "contract" }),
    );

    const runs = await inTenant(tenantId, ({ db }) => db.select().from(processingRuns));
    const byId = Object.fromEntries(runs.map((r) => [r.id, r]));
    expect(byId[failed.runId]).toMatchObject({ status: "failed", supersededBy: retryId });
    expect(byId[done.runId]).toMatchObject({ status: "superseded", supersededBy: reclassifyId });
    expect(byId[retryId]).toMatchObject({ trigger: "retry", forcedCategory: null, status: "running" });
    expect(byId[reclassifyId]).toMatchObject({ trigger: "reclassify", forcedCategory: "contract" });

    const docs = await inTenant(tenantId, ({ db }) => db.select().from(documents));
    const doc = (id: string) => docs.find((d) => d.id === id);
    expect(doc(failed.documentId)).toMatchObject({ currentRunId: retryId, processingStatus: "received" });
    expect(doc(done.documentId)).toMatchObject({ currentRunId: reclassifyId, processingStatus: "classified" });
    expect(await boss.getJobById(QUEUES.parse, stageJobId(retryId, "parse"))).not.toBeNull();
    expect(await boss.getJobById(QUEUES.extract, stageJobId(reclassifyId, "extract"))).not.toBeNull();
  });
});

describe("guards", () => {
  it("lets route record a decision once, and never changes an extraction's values", async () => {
    const tenantId = await tenantWithConfig();
    const { extractionId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const id = extractionId ?? "";
    // Already decided by the seed: the app guard matches nothing, and a direct update is refused.
    expect(
      await inTenant(tenantId, (tx) =>
        applyRouteDecision(tx, id, { gateResults: {}, score: 1, decision: "auto", reasons: [] }),
      ),
    ).toBe(false);
    await expectPgError(
      inTenant(tenantId, ({ db }) => db.update(extractions).set({ decision: "auto" }).where(eq(extractions.id, id))),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(tenantId, ({ db }) => db.update(extractions).set({ fields: {} }).where(eq(extractions.id, id))),
      PG.integrityViolation,
    );
  });

  it("freezes an action's payload and keeps decisions insert-only", async () => {
    const tenantId = await tenantWithConfig();
    const { documentId, extractionId, taskId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const actionId = await inTenant(tenantId, (tx) =>
      createAction(tx, { documentId, extractionId: extractionId ?? "", payload: { a: 1 } }),
    );
    await inTenant(tenantId, ({ db }) => db.update(actions).set({ attempts: 2 }).where(eq(actions.id, actionId)));
    await expectPgError(
      inTenant(tenantId, ({ db }) =>
        db
          .update(actions)
          .set({ payload: { a: 2 } })
          .where(eq(actions.id, actionId)),
      ),
      PG.integrityViolation,
    );
    await expectPgError(
      inTenant(tenantId, ({ db }) => db.delete(actions).where(eq(actions.id, actionId))),
      PG.integrityViolation,
    );

    const decisionId = await inTenant(tenantId, async (tx) => {
      const [task] = await tx.db.select().from(reviewTasks).where(eq(reviewTasks.id, taskId));
      if (!task) throw new Error("task missing");
      return insertDecision(tx, { task, reviewerId: alice, outcome: "reject", note: "spam" });
    });
    await expectPgError(
      inTenant(tenantId, ({ db }) =>
        db.update(reviewDecisions).set({ note: "edited" }).where(eq(reviewDecisions.id, decisionId)),
      ),
      PG.integrityViolation,
    );
  });
});

describe("delivery and settings", () => {
  it("requeues only failed or delivered actions, with a fresh job and the same action id", async () => {
    const tenantId = await tenantWithConfig();
    const { documentId, extractionId } = await inTenant(tenantId, (tx) => seedReviewTask(tx));
    const actionId = await inTenant(tenantId, (tx) =>
      createAction(tx, { documentId, extractionId: extractionId ?? "", payload: {} }),
    );
    expect(await inTenant(tenantId, (tx) => requeueAction(tx, boss, actionId))).toBe(false);
    expect(
      await inTenant(tenantId, (tx) => markDeliveryFailed(tx, { actionId, error: "HTTP 500", countAttempt: true })),
    ).toBe(true);
    expect(await inTenant(tenantId, (tx) => requeueAction(tx, boss, actionId))).toBe(true);
    const [action] = await inTenant(tenantId, ({ db }) => db.select().from(actions).where(eq(actions.id, actionId)));
    expect(action).toMatchObject({ status: "pending", attempts: 1, lastError: null });
    const jobs = await boss.findJobs(QUEUES.deliver, { data: { actionId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).not.toBe(actionId);
  });

  it("creates a webhook secret once, stores it encrypted, and shows only a hint of it", async () => {
    const tenantId = await newTenant(app);
    const first = await inTenant(tenantId, (tx) => setWebhook(tx, KEYS, { url: "https://example.test/hook" }));
    expect(first.secret).toMatch(/^whsec_/);
    const second = await inTenant(tenantId, (tx) => setWebhook(tx, KEYS, { url: "https://example.test/other" }));
    expect(second.secret).toBeNull();
    const settings = await inTenant(tenantId, (tx) => getWebhookSettings(tx, KEYS));
    expect(settings).toEqual({
      url: "https://example.test/other",
      secretSet: true,
      secretHint: expect.any(String),
      previousSecretValidUntil: null,
    });
    expect(first.secret?.startsWith(settings.secretHint?.slice(0, -1) ?? "?")).toBe(true);
    // At rest: ciphertext only, nothing in the legacy plaintext column.
    const [row] = await inTenant(tenantId, (tx) => tx.db.select().from(tenantSettings));
    expect(row?.webhookSecret).toBeNull();
    expect(row?.webhookSecretEnc).toMatch(/^v1:/);
    expect(row?.webhookSecretEnc).not.toContain(first.secret ?? "?");
  });

  it("signs with the old secret too for a grace period after a rotation", async () => {
    const tenantId = await newTenant(app);
    const now = new Date("2026-11-03T12:00:00Z");
    const { secret: old } = await inTenant(tenantId, (tx) => setWebhook(tx, KEYS, { url: "https://example.test/h" }));
    const rotated = await inTenant(tenantId, (tx) => rotateWebhookSecret(tx, KEYS, now));
    expect(rotated).not.toBe(old);
    const during = await inTenant(tenantId, (tx) => webhookTarget(tx, KEYS, new Date(now.getTime() + 3_600_000)));
    expect(during.secrets).toEqual([rotated, old]);
    const after = await inTenant(tenantId, (tx) => webhookTarget(tx, KEYS, new Date(now.getTime() + 25 * 3_600_000)));
    expect(after.secrets).toEqual([rotated]);
  });

  it("encrypts plaintext secrets left by older versions (db:migrate)", async () => {
    const tenantId = await newTenant(app);
    await inTenant(tenantId, (tx) =>
      tx.db.update(tenantSettings).set({ webhookUrl: "https://example.test/h", webhookSecret: "whsec_old" }),
    );
    expect(await encryptLegacyWebhookSecrets(app, KEYS)).toBeGreaterThanOrEqual(1);
    expect((await inTenant(tenantId, (tx) => webhookTarget(tx, KEYS, new Date()))).secrets).toEqual(["whsec_old"]);
    const [row] = await inTenant(tenantId, (tx) => tx.db.select().from(tenantSettings));
    expect(row?.webhookSecret).toBeNull();
  });
});
