import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { QUEUES } from "@ai-triage/core";
import { approvedPayload, egressPolicy, proposeAction } from "@ai-triage/core/pipeline";
import {
  buildPipelineConfig,
  createAction,
  createBoss,
  createPool,
  enqueue,
  getDocumentDetail,
  keyRingFromEnv,
  type PgBoss,
  requeueAction,
  setReviewOutcome,
  setWebhook,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, SAMPLE_INVOICE_FIELDS, seedReviewTask, testDbUrls } from "@ai-triage/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deliverAction } from "./deliver";
import type { DeliveryDeps } from "./deps";
import { drainDeliveries } from "./drain";
import { createGuardedFetch } from "./egress";
import { verifyWebhook } from "./sign";

// Webhook delivery against a real HTTP receiver: signing, the Idempotency-Key, permanent versus
// transient failures, the dead letter, and Redeliver (docs/architecture.md §5, §10).

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
let boss: PgBoss;

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}
let received: Received[] = [];
/** How the receiver answers each request: a status code, or "hang" to never answer. */
let respond: (path: string) => number | "hang" = () => 200;
let server: Server;
let base = "";

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "/";
      received.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const status = respond(path);
      if (status === "hang") return;
      res.writeHead(status, status >= 300 && status < 400 ? { location: `${base}/elsewhere` } : {});
      res.end(status >= 400 ? "receiver says no" : "ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await boss.stop({ graceful: false });
  await pool.end();
});
beforeEach(() => {
  received = [];
  respond = () => 200;
});

const NOW = new Date("2026-11-03T12:00:00Z");
const SECRET = "whsec_test_secret";

const KEYS = keyRingFromEnv({});
// The receiver listens on 127.0.0.1, which only an allowlist lets a webhook reach.
const guardedFetch = createGuardedFetch(egressPolicy(["127.0.0.1"]));

function deps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return { pool, boss, keys: KEYS, fetch: guardedFetch, now: () => NOW, timeoutMs: 2000, ...overrides };
}

/** A tenant with a webhook (or none), and one approved action waiting in the outbox. */
async function approved(webhookPath: string | null = "/hook") {
  const tenantId = await newTenant(pool);
  return withTenantTx(pool, tenantId, async (tx) => {
    await buildPipelineConfig(tx);
    if (webhookPath) await setWebhook(tx, KEYS, { url: `${base}${webhookPath}`, secret: SECRET });
    const task = await seedReviewTask(tx);
    const extractionId = task.extractionId ?? "";
    const payload = approvedPayload(
      proposeAction({ documentId: task.documentId, extractionId, category: "invoice", values: SAMPLE_INVOICE_FIELDS }),
      "auto",
      NOW,
    );
    const actionId = await createAction(tx, { documentId: task.documentId, extractionId, payload });
    await setReviewOutcome(tx, task.documentId, { reviewStatus: "approved", deliveryStatus: "pending" });
    await enqueue(boss, tx, QUEUES.deliver, { tenantId, actionId }, { id: actionId });
    return { tenantId, actionId, documentId: task.documentId };
  });
}

async function state(tenantId: string, documentId: string) {
  const d = await withTenantTx(pool, tenantId, (tx) => getDocumentDetail(tx, documentId));
  return { delivery: d?.document.deliveryStatus, action: d?.actions[0] };
}

describe("deliverAction", () => {
  it("POSTs the frozen payload, signed, with the action id as the Idempotency-Key", async () => {
    const a = await approved();
    await drainDeliveries(deps(), a.tenantId);
    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req?.headers["idempotency-key"]).toBe(a.actionId);
    expect(req?.headers["x-triage-event"]).toBe("document.approved");
    const signature = req?.headers["x-triage-signature"] as string;
    expect(verifyWebhook(SECRET, signature, a.actionId, req?.body ?? "", NOW)).toBe(true);
    expect(verifyWebhook("whsec_other", signature, a.actionId, req?.body ?? "", NOW)).toBe(false);
    expect(verifyWebhook(SECRET, signature, a.actionId, `${req?.body} `, NOW)).toBe(false);
    // The Idempotency-Key is signed: the same body under another key doesn't verify.
    expect(verifyWebhook(SECRET, signature, "another-key", req?.body ?? "", NOW)).toBe(false);
    expect(JSON.parse(req?.body ?? "")).toMatchObject({ document_id: a.documentId, fields: SAMPLE_INVOICE_FIELDS });
    expect(await state(a.tenantId, a.documentId)).toMatchObject({
      delivery: "delivered",
      action: { status: "delivered", attempts: 1, lastError: null, deliveredAt: NOW },
    });

    // A duplicate job for a delivered action sends nothing.
    await deliverAction(deps(), { tenantId: a.tenantId, actionId: a.actionId });
    expect(received).toHaveLength(1);
  });

  it("retries a 5xx, counting attempts, then dead-letters to a failed action", async () => {
    const a = await approved();
    respond = () => 503;
    await expect(deliverAction(deps(), { tenantId: a.tenantId, actionId: a.actionId })).rejects.toThrow("HTTP 503");
    expect(await state(a.tenantId, a.documentId)).toMatchObject({
      delivery: "pending",
      action: { status: "pending", attempts: 1, lastError: "HTTP 503: receiver says no" },
    });

    await drainDeliveries(deps(), a.tenantId);
    const after = await state(a.tenantId, a.documentId);
    expect(after).toMatchObject({ delivery: "failed", action: { status: "failed" } });
    expect(after.action?.lastError).toMatch(/^retries exhausted: HTTP 503/);
    expect(after.action?.attempts).toBe(1 + 9);
  });

  it("fails at once on a 4xx, a redirect, or no configured webhook", async () => {
    respond = () => 422;
    const rejected = await approved();
    await deliverAction(deps(), { tenantId: rejected.tenantId, actionId: rejected.actionId });
    expect(await state(rejected.tenantId, rejected.documentId)).toMatchObject({
      delivery: "failed",
      action: { status: "failed", attempts: 1, lastError: "HTTP 422: receiver says no" },
    });

    respond = (path) => (path === "/hook" ? 302 : 200);
    const redirected = await approved();
    received = [];
    await deliverAction(deps(), { tenantId: redirected.tenantId, actionId: redirected.actionId });
    expect(received.map((r) => r.path)).toEqual(["/hook"]);
    expect((await state(redirected.tenantId, redirected.documentId)).action?.status).toBe("failed");

    const unconfigured = await approved(null);
    await deliverAction(deps(), { tenantId: unconfigured.tenantId, actionId: unconfigured.actionId });
    expect((await state(unconfigured.tenantId, unconfigured.documentId)).action).toMatchObject({
      status: "failed",
      lastError: "no webhook URL configured for this tenant",
    });
  });

  it("treats a timeout as transient", async () => {
    const a = await approved();
    respond = () => "hang";
    await expect(
      deliverAction(deps({ timeoutMs: 200 }), { tenantId: a.tenantId, actionId: a.actionId }),
    ).rejects.toThrow("timed out after 200 ms");
    expect((await state(a.tenantId, a.documentId)).action).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("redelivers with the same Idempotency-Key and no second action", async () => {
    respond = () => 422;
    const a = await approved();
    await drainDeliveries(deps(), a.tenantId);
    respond = () => 200;
    expect(await withTenantTx(pool, a.tenantId, (tx) => requeueAction(tx, boss, a.actionId))).toBe(true);
    await drainDeliveries(deps(), a.tenantId);

    // Forced redelivery of an action that was already delivered.
    expect(await withTenantTx(pool, a.tenantId, (tx) => requeueAction(tx, boss, a.actionId))).toBe(true);
    await drainDeliveries(deps(), a.tenantId);

    expect(received.map((r) => r.headers["idempotency-key"])).toEqual([a.actionId, a.actionId, a.actionId]);
    const d = await withTenantTx(pool, a.tenantId, (tx) => getDocumentDetail(tx, a.documentId));
    expect(d?.actions).toHaveLength(1);
    expect(d?.actions[0]).toMatchObject({ status: "delivered", attempts: 3 });
    expect(d?.document.deliveryStatus).toBe("delivered");
  });
});
