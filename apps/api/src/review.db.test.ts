import { randomUUID } from "node:crypto";
import type { ClaimResponse, DecisionResponse, ErrorResponse, InboxResponse } from "@ai-triage/contracts";
import { QUEUES } from "@ai-triage/core";
import { normalizePostmark } from "@ai-triage/core/pipeline";
import {
  addMembership,
  buildPipelineConfig,
  ensurePasswordUser,
  getDocumentDetail,
  stageJobId,
  withTenantTx,
} from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { newTenant, SAMPLE_INVOICE_FIELDS, seedReviewTask } from "@ai-triage/db/testing";
import { ingestEmail } from "@ai-triage/ingest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createTestApp, WEB_ORIGIN } from "./test-app";

// The review queue over HTTP: claims, the five decisions, and the 409/422 refusals that keep a stale
// tab or a wrong action from changing anything (docs/architecture.md §5, §10).

const t = await createTestApp();
const { app, pool, boss } = t;
afterAll(t.close);
afterEach(() => t.setNow(null));

type Seed = Parameters<typeof seedReviewTask>[1];

async function setup() {
  const tenantId = await newTenant(pool);
  await withTenantTx(pool, tenantId, (tx) => buildPipelineConfig(tx));
  const reviewer = await t.memberCookie(tenantId, "reviewer");
  const seed = (input: Seed = {}) => withTenantTx(pool, tenantId, (tx) => seedReviewTask(tx, input));
  const detail = (documentId: string) => withTenantTx(pool, tenantId, (tx) => getDocumentDetail(tx, documentId));
  /** Another reviewer in the same tenant. */
  const colleague = async () => {
    const email = `colleague-${randomUUID().slice(0, 8)}@test.test`;
    const userId = await ensurePasswordUser(t.db, { email, name: "Colleague", password: DEMO_PASSWORD });
    await addMembership(t.db, userId, tenantId, "reviewer");
    return (await t.signIn(email)).cookie;
  };
  return { tenantId, reviewer, seed, detail, colleague };
}

const post = (path: string, cookie: string, body: unknown = {}) =>
  app.request(path, {
    method: "POST",
    headers: { cookie, origin: WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function claim(cookie: string, taskId: string): Promise<ClaimResponse> {
  const res = await post(`/review/tasks/${taskId}/claim`, cookie);
  expect(res.status).toBe(200);
  return (await res.json()) as ClaimResponse;
}

const decide = (cookie: string, taskId: string, body: Record<string, unknown>) =>
  post(`/review/tasks/${taskId}/decisions`, cookie, body);

async function refused(res: Response, status: number, code: string): Promise<ErrorResponse> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ErrorResponse;
  expect(body.code).toBe(code);
  return body;
}

describe("approve", () => {
  it("freezes the exact revision into an action, enqueues its delivery and resolves the task", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const res = await decide(s.reviewer, task.taskId, {
      action: "approve",
      claimToken,
      extractionId: task.extractionId,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DecisionResponse;
    expect(body).toMatchObject({ outcome: "approve", extractionId: task.extractionId, actionId: expect.any(String) });

    const d = await s.detail(task.documentId);
    expect(d?.document).toMatchObject({ reviewStatus: "approved", deliveryStatus: "pending" });
    expect(d?.task).toBeNull();
    expect(d?.actions).toHaveLength(1);
    expect(d?.actions[0]?.payload).toMatchObject({
      event: "document.approved",
      extraction_id: task.extractionId,
      fields: SAMPLE_INVOICE_FIELDS,
      approved_by: { type: "user", email: `reviewer-${s.tenantId.slice(0, 8)}@test.test` },
    });
    expect(d?.decisions).toMatchObject([{ outcome: "approve", taskKind: "review", extractionId: task.extractionId }]);
    expect(await boss.getJobById(QUEUES.deliver, body.actionId ?? "")).toMatchObject({
      data: { tenantId: s.tenantId, actionId: body.actionId },
    });
  });

  it("refuses a stale claim token, a lapsed lease and an outdated revision with 409", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken, leaseExpiresAt } = await claim(s.reviewer, task.taskId);
    const approve = { action: "approve", claimToken, extractionId: task.extractionId };
    await refused(await decide(s.reviewer, task.taskId, { ...approve, claimToken: randomUUID() }), 409, "claim_lost");
    await refused(
      await decide(s.reviewer, task.taskId, { ...approve, extractionId: randomUUID() }),
      409,
      "stale_revision",
    );
    t.setNow(new Date(new Date(leaseExpiresAt).getTime() + 1000));
    await refused(await decide(s.reviewer, task.taskId, approve), 409, "claim_lost");
    expect((await s.detail(task.documentId))?.actions).toEqual([]);
  });

  it("lets exactly one of two concurrent approvals through", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const approve = { action: "approve", claimToken, extractionId: task.extractionId };
    const results = await Promise.all([
      decide(s.reviewer, task.taskId, approve),
      decide(s.reviewer, task.taskId, approve),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await s.detail(task.documentId))?.actions).toHaveLength(1);
  });

  it("turns away a second reviewer while the claim is live", async () => {
    const s = await setup();
    const task = await s.seed();
    await claim(s.reviewer, task.taskId);
    const other = await s.colleague();
    const busy = await refused(await post(`/review/tasks/${task.taskId}/claim`, other), 409, "claimed_by_other");
    expect(busy.details).toMatchObject({ claimedBy: `reviewer-${s.tenantId.slice(0, 8)}@test.test` });
  });
});

describe("edit & approve", () => {
  it("writes the edit as a new user revision and approves that revision", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const fields = { ...SAMPLE_INVOICE_FIELDS, invoice_number: "INV-1001-A" };
    const res = await decide(s.reviewer, task.taskId, {
      action: "edit_approve",
      claimToken,
      extractionId: task.extractionId,
      fields,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as DecisionResponse;
    expect(body.outcome).toBe("edit_approve");
    expect(body.extractionId).not.toBe(task.extractionId);

    const d = await s.detail(task.documentId);
    expect(d?.extraction).toMatchObject({
      id: body.extractionId,
      revision: 2,
      author: "user",
      parentId: task.extractionId,
    });
    expect(d?.document.currentExtractionId).toBe(body.extractionId);
    expect(d?.actions[0]).toMatchObject({ extractionId: body.extractionId });
    expect(d?.actions[0]?.payload).toMatchObject({
      extraction_id: body.extractionId,
      fields: { invoice_number: "INV-1001-A" },
    });
    expect(d?.decisions[0]).toMatchObject({
      outcome: "edit_approve",
      diff: [{ field: "invoice_number", before: "INV-1001", after: "INV-1001-A" }],
    });
  });

  it("refuses values that break the schema, writing nothing", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const res = await decide(s.reviewer, task.taskId, {
      action: "edit_approve",
      claimToken,
      extractionId: task.extractionId,
      fields: { ...SAMPLE_INVOICE_FIELDS, invoice_date: "first of October" },
    });
    const body = await refused(res, 422, "invalid_fields");
    expect(body.issues?.map((i) => i.field)).toContain("invoice_date");
    const d = await s.detail(task.documentId);
    expect(d?.revisions).toHaveLength(1);
    expect(d?.decisions).toEqual([]);
    expect(d?.actions).toEqual([]);
    expect(d?.task).toMatchObject({ status: "claimed" });
  });

  it("approves the shown revision when the edit changed nothing", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const res = await decide(s.reviewer, task.taskId, {
      action: "edit_approve",
      claimToken,
      extractionId: task.extractionId,
      fields: { ...SAMPLE_INVOICE_FIELDS },
    });
    expect(await res.json()).toMatchObject({ outcome: "approve", extractionId: task.extractionId });
  });
});

describe("actions by task kind", () => {
  it("refuses an action the task's kind doesn't allow with 422", async () => {
    const s = await setup();
    const failed = await s.seed({ kind: "processing_failed" });
    const failedClaim = await claim(s.reviewer, failed.taskId);
    await refused(
      await decide(s.reviewer, failed.taskId, {
        action: "approve",
        claimToken: failedClaim.claimToken,
        extractionId: randomUUID(),
      }),
      422,
      "action_not_allowed",
    );
    const review = await s.seed();
    const reviewClaim = await claim(s.reviewer, review.taskId);
    await refused(
      await decide(s.reviewer, review.taskId, { action: "retry", claimToken: reviewClaim.claimToken }),
      422,
      "action_not_allowed",
    );
  });
});

describe("reclassify", () => {
  it("starts a reclassify run, clears the claim and blocks approval until the new extraction lands", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    for (const category of ["other", "invoice", "recipe"]) {
      await refused(
        await decide(s.reviewer, task.taskId, { action: "reclassify", claimToken, category }),
        422,
        "invalid_category",
      );
    }
    const res = await decide(s.reviewer, task.taskId, { action: "reclassify", claimToken, category: "contract" });
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as DecisionResponse;

    const d = await s.detail(task.documentId);
    expect(d?.task).toMatchObject({
      id: task.taskId,
      status: "awaiting_extraction",
      claimToken: null,
      claimedBy: null,
    });
    expect(d?.run).toMatchObject({ id: runId, trigger: "reclassify", forcedCategory: "contract" });
    expect(d?.document.processingStatus).toBe("classified");
    expect(d?.decisions[0]).toMatchObject({ outcome: "reclassify" });
    expect(await boss.getJobById(QUEUES.extract, stageJobId(runId ?? "", "extract"))).not.toBeNull();

    const approve = { action: "approve", claimToken, extractionId: task.extractionId };
    await refused(await decide(s.reviewer, task.taskId, approve), 409, "reprocessing");
    await refused(await post(`/review/tasks/${task.taskId}/claim`, s.reviewer), 409, "reprocessing");
  });

  it("moves an unclassified document into a configured category", async () => {
    const s = await setup();
    const task = await s.seed({ kind: "unclassified" });
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const res = await decide(s.reviewer, task.taskId, { action: "reclassify", claimToken, category: "invoice" });
    expect(res.status).toBe(200);
  });
});

describe("reject and retry", () => {
  it("makes reject terminal: no action, and nothing more can be decided", async () => {
    const s = await setup();
    const task = await s.seed();
    const { claimToken } = await claim(s.reviewer, task.taskId);
    expect((await decide(s.reviewer, task.taskId, { action: "reject", claimToken, note: "spam" })).status).toBe(200);
    const d = await s.detail(task.documentId);
    expect(d?.document).toMatchObject({ reviewStatus: "rejected", deliveryStatus: "none" });
    expect(d?.actions).toEqual([]);
    expect(d?.decisions[0]).toMatchObject({ outcome: "reject", note: "spam" });
    await refused(await decide(s.reviewer, task.taskId, { action: "reject", claimToken }), 409, "task_resolved");
    await refused(await post(`/review/tasks/${task.taskId}/claim`, s.reviewer), 409, "task_resolved");
  });

  it("retries a failed document with a new run and closes its task", async () => {
    const s = await setup();
    const task = await s.seed({ kind: "processing_failed" });
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const res = await decide(s.reviewer, task.taskId, { action: "retry", claimToken });
    const { runId } = (await res.json()) as DecisionResponse;
    const d = await s.detail(task.documentId);
    expect(d?.run).toMatchObject({ id: runId, trigger: "retry" });
    expect(d?.document).toMatchObject({ processingStatus: "received", reviewStatus: "not_required" });
    expect(d?.task).toBeNull();
    expect(await boss.getJobById(QUEUES.parse, stageJobId(runId ?? "", "parse"))).not.toBeNull();
  });

  it("retries a failed reclassify run as a reclassify run", async () => {
    const s = await setup();
    const task = await s.seed({ kind: "processing_failed", forcedCategory: "contract" });
    const { claimToken } = await claim(s.reviewer, task.taskId);
    const { runId } = (await (
      await decide(s.reviewer, task.taskId, { action: "retry", claimToken })
    ).json()) as DecisionResponse;
    expect((await s.detail(task.documentId))?.run).toMatchObject({
      id: runId,
      trigger: "reclassify",
      forcedCategory: "contract",
    });
    expect(await boss.getJobById(QUEUES.extract, stageJobId(runId ?? "", "extract"))).not.toBeNull();
  });
});

describe("inbox and access", () => {
  it("lists open tasks with counts, and filters by reason code and claim", async () => {
    const s = await setup();
    const a = await s.seed({ reasons: ["required_missing:total"] });
    await s.seed({ kind: "unclassified" });
    await claim(s.reviewer, a.taskId);
    const res = await app.request("/review/tasks", { headers: { cookie: s.reviewer } });
    const inbox = (await res.json()) as InboxResponse;
    expect(inbox.counts).toMatchObject({ total: 2, kind: { review: 1, unclassified: 1 } });
    expect(inbox.tasks.find((x) => x.id === a.taskId)?.claim).toMatchObject({
      email: expect.stringContaining("reviewer-"),
    });

    const byReason = await app.request("/review/tasks?reason=required_missing", { headers: { cookie: s.reviewer } });
    expect(((await byReason.json()) as InboxResponse).tasks.map((x) => x.id)).toEqual([a.taskId]);
    const mine = await app.request("/review/tasks?mine=1", { headers: { cookie: s.reviewer } });
    expect(((await mine.json()) as InboxResponse).tasks.map((x) => x.id)).toEqual([a.taskId]);
    const bad = await app.request("/review/tasks?kind=nope", { headers: { cookie: s.reviewer } });
    expect(bad.status).toBe(400);
  });

  it("lets a viewer read the inbox but not claim or decide, and hides other tenants' tasks", async () => {
    const s = await setup();
    const task = await s.seed();
    const viewer = await t.memberCookie(s.tenantId, "viewer");
    expect((await app.request("/review/tasks", { headers: { cookie: viewer } })).status).toBe(200);
    expect((await post(`/review/tasks/${task.taskId}/claim`, viewer)).status).toBe(403);
    expect((await post("/review/claim-next", viewer)).status).toBe(403);
    expect((await decide(viewer, task.taskId, { action: "reject", claimToken: randomUUID() })).status).toBe(403);

    const other = await setup();
    expect((await post(`/review/tasks/${task.taskId}/claim`, other.reviewer)).status).toBe(404);
    expect((await decide(other.reviewer, task.taskId, { action: "reject", claimToken: randomUUID() })).status).toBe(
      404,
    );
  });

  it("hands out the oldest free task on claim-next, then nothing", async () => {
    const s = await setup();
    const first = await s.seed();
    await s.seed({ kind: "audit" });
    const next = await post("/review/claim-next", s.reviewer, { kind: "review" });
    expect(await next.json()).toMatchObject({ claim: { taskId: first.taskId } });
    const none = await post("/review/claim-next", s.reviewer, { kind: "review" });
    expect(await none.json()).toEqual({ claim: null });
  });
});

describe("email view", () => {
  it("returns the original HTML, sanitized", async () => {
    const s = await setup();
    const payload = {
      MessageID: randomUUID(),
      Subject: "Invoice INV-77",
      From: "billing@vendor.example",
      TextBody: "Please find invoice INV-77.",
      HtmlBody:
        '<p>Please find <b>invoice INV-77</b>.</p><script>alert(1)</script><img src="https://tracker.example/p.gif">',
    };
    const { documentId } = await ingestEmail(
      { pool, boss, storage: t.storage },
      s.tenantId,
      normalizePostmark(payload),
      {
        source: "email",
        postmark: payload,
      },
    );
    const res = await app.request(`/documents/${documentId}/email`, { headers: { cookie: s.reviewer } });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { html: string; text: string; subject: string };
    expect(view).toMatchObject({ subject: "Invoice INV-77", text: "Please find invoice INV-77." });
    expect(view.html).toContain("<b>invoice INV-77</b>");
    expect(view.html).not.toContain("script");
    expect(view.html).not.toContain("tracker.example");
  });
});
