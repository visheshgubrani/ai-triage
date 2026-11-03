import { QUEUES } from "@ai-triage/core";
import {
  buildPipelineConfig,
  commitSync,
  connectMailbox,
  createBoss,
  createPool,
  keyRingFromEnv,
  listDocuments,
  type PgBoss,
  purgeDocument,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, tenantQuery, testDbUrls } from "@ai-triage/db/testing";
import { snapshotDocumentSource } from "@ai-triage/ingest";
import {
  authorizationUrl,
  exchangeCode,
  type GoogleConfig,
  getProfile,
  MAILBOX_SCOPES,
  pkcePair,
} from "@ai-triage/mailbox";
import { FakeGoogle } from "@ai-triage/mailbox/testing";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSender } from "../pipeline/source";
import type { MailboxDeps } from "./deps";
import { drainMailboxJobs } from "./drain";
import { pollMailboxes, syncMailbox } from "./sync";

// Gmail sync (phase 6, M4) against a fake Google: new mail becomes one document per message, a
// message is fetched once however often it's listed, an expired cursor resyncs without gaps, a dead
// grant stops polling, and a purged document's message isn't ingested again.

const config: GoogleConfig = {
  clientId: "worker-client",
  clientSecret: "worker-secret",
  oauthUrl: "https://accounts.google.com",
  tokenUrl: "https://oauth2.googleapis.com",
  apiUrl: "https://gmail.googleapis.com",
};
const REDIRECT = "http://localhost:8787/integrations/google/callback";
const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const keys = keyRingFromEnv({});
const google = new FakeGoogle(config);
let boss: PgBoss;
let deps: MailboxDeps;

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  deps = {
    pool,
    boss,
    storage: createStorage(storageConfigFromEnv()),
    keys,
    google: { config, fetch: google.fetch },
    limits: { maxFileBytes: 20 * 2 ** 20, syncBatch: 200, inboundPerHour: 100_000 },
    now: () => new Date(),
  };
});
afterAll(async () => {
  await boss.stop({ graceful: false });
  await pool.end();
});

let n = 0;
const eml = (subject: string, extra = "") =>
  `From: Vendor <billing@vendor.test>\r\nTo: ap@acme.test\r\nSubject: ${subject}\r\n` +
  `Message-ID: <${subject}-${++n}@vendor.test>\r\nDate: Tue, 3 Nov 2026 10:00:00 +0000\r\n${extra}` +
  `Content-Type: text/plain\r\n\r\nInvoice ${subject} attached.\r\n`;

/** A tenant with a config and a connected mailbox (the grant comes from the fake's consent). */
async function connected(options: { labelId?: string; tenantId?: string } = {}) {
  const tenantId = options.tenantId ?? (await newTenant(pool));
  if (!options.tenantId) await withTenantTx(pool, tenantId, (tx) => buildPipelineConfig(tx));
  const email = google.addMailbox(`ap-${crypto.randomUUID().slice(0, 8)}@acme.test`).email;
  const { verifier, challenge } = pkcePair();
  const url = authorizationUrl(deps.google ?? { config }, {
    state: "s",
    codeChallenge: challenge,
    redirectUri: REDIRECT,
    scopes: MAILBOX_SCOPES,
    offline: true,
  });
  const code = new URL(google.consent(url, { email })).searchParams.get("code") ?? "";
  const g = { config, fetch: google.fetch };
  const tokens = await exchangeCode(g, { code, codeVerifier: verifier, redirectUri: REDIRECT });
  const profile = await getProfile(g, tokens.accessToken);
  const userId = (await pool.query("select id from users limit 1")).rows[0].id;
  const { id } = await withTenantTx(pool, tenantId, (tx) =>
    connectMailbox(tx, keys, {
      provider: "google",
      email,
      providerAccountId: null,
      refreshToken: tokens.refreshToken ?? "",
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.expiresAt,
      scopes: tokens.scopes,
      historyId: profile.historyId,
      backfillDays: null,
      connectedBy: userId,
      now: new Date(),
    }),
  );
  if (options.labelId) {
    await tenantQuery(pool, tenantId, "update mailbox_connections set label_id = $2 where id = $1", [
      id,
      options.labelId,
    ]);
  }
  return { tenantId, email, connectionId: id };
}

const sync = (tenantId: string, connectionId: string) => syncMailbox(deps, { tenantId, connectionId });
const ledger = (tenantId: string) =>
  tenantQuery<{ provider_message_id: string; status: string; reason: string | null; document_id: string | null }>(
    pool,
    tenantId,
    "select provider_message_id, status, reason, document_id from mailbox_messages order by created_at, provider_message_id",
  );
const docs = (tenantId: string) => withTenantTx(pool, tenantId, (tx) => listDocuments(tx, { limit: 50 }));

describe("Gmail sync", () => {
  it("ingests new inbound mail once, keeping the raw message, and skips what isn't inbound", async () => {
    const { tenantId, email, connectionId } = await connected();
    const one = google.deliver(email, eml("one"));
    google.deliver(email, eml("spam"), ["SPAM"]);
    google.deliver(email, eml("sent"), ["SENT"]);
    await sync(tenantId, connectionId);
    // Listed again (labelled later, and a second sync of unchanged history): still one fetch.
    google.addLabel(email, one, "IMPORTANT");
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);

    const documents = await docs(tenantId);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ source: "gmail", title: "one" });
    expect(await ledger(tenantId)).toEqual([
      { provider_message_id: one, status: "ingested", reason: null, document_id: documents[0]?.id },
    ]);
    const [row] = await tenantQuery<{ source_key: string }>(pool, tenantId, "select source_key from documents");
    const key = row?.source_key.replace(/email\.json$/, "source.eml") ?? "";
    expect(new TextDecoder().decode(await deps.storage.get(key))).toContain("Subject: one");
  });

  it("files mail by the intake label, including mail the label is applied to later", async () => {
    const { tenantId, email, connectionId } = await connected({ labelId: "Label_1" });
    google.deliver(email, eml("inbox-only"));
    const later = google.deliver(email, eml("filed-later"));
    google.addLabel(email, later, "Label_1");
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);
    expect((await docs(tenantId)).map((d) => d.title)).toEqual(["filed-later"]);
  });

  it("makes one document of a message that reaches two connected mailboxes", async () => {
    const a = await connected();
    const b = await connected({ tenantId: a.tenantId });
    const raw = eml("shared");
    google.deliver(a.email, raw);
    google.deliver(b.email, raw);
    await sync(a.tenantId, a.connectionId);
    await sync(a.tenantId, b.connectionId);
    await drainMailboxJobs(deps, a.tenantId);
    expect(await docs(a.tenantId)).toHaveLength(1);
    expect((await ledger(a.tenantId)).map((r) => r.status).sort()).toEqual(["duplicate", "ingested"]);
  });

  it("resyncs without gaps when Gmail's history has expired", async () => {
    const { tenantId, email, connectionId } = await connected();
    google.deliver(email, eml("before-expiry"));
    google.expireHistory(email);
    await sync(tenantId, connectionId);
    google.deliver(email, eml("after-resync"));
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);
    expect((await docs(tenantId)).map((d) => d.title).sort()).toEqual(["after-resync", "before-expiry"]);
  });

  it("refuses a commit whose cursor another sync moved since (compare-and-set)", async () => {
    const { tenantId, email, connectionId } = await connected();
    google.deliver(email, eml("race"));
    await sync(tenantId, connectionId);
    const stale = await withTenantTx(pool, tenantId, (tx) =>
      commitSync(tx, boss, {
        connectionId,
        expectedVersion: 0,
        historyId: "1",
        messageIds: ["stale-message"],
        backfillDone: false,
        now: new Date(),
        nextSyncAt: new Date(),
      }),
    );
    expect(stale).toEqual({ committed: false, queued: 0 });
    expect((await ledger(tenantId)).map((r) => r.provider_message_id)).not.toContain("stale-message");
    await drainMailboxJobs(deps, tenantId);
    expect(await docs(tenantId)).toHaveLength(1);
  });

  it("stops polling a mailbox whose grant was revoked, and audits it once", async () => {
    const { tenantId, email, connectionId } = await connected();
    google.revokeGrants(email);
    await tenantQuery(pool, tenantId, "update mailbox_connections set access_token_expires_at = now() where id = $1", [
      connectionId,
    ]);
    await sync(tenantId, connectionId);
    const [row] = await tenantQuery<{ status: string }>(pool, tenantId, "select status from mailbox_connections");
    expect(row?.status).toBe("reauth_required");
    const audits = await tenantQuery(
      pool,
      tenantId,
      "select 1 from audit_events where action = 'mailbox.reauth_required'",
    );
    expect(audits).toHaveLength(1);
    // The poll no longer picks it up.
    await pollMailboxes(deps);
    const jobs = await boss.findJobs(QUEUES.mailboxSync, { data: { connectionId }, queued: true });
    expect(jobs).toEqual([]);
  });

  it("skips mail over the limits and records why", async () => {
    const { tenantId, email, connectionId } = await connected();
    // Over the download cap (attachments base64-encoded, plus 1 MiB of headroom).
    const big = google.deliver(email, eml("big", `X-Pad: ${"x".repeat(1_200_000)}\r\n`));
    const gone = google.deliver(email, eml("gone"));
    await sync(tenantId, connectionId);
    google.deleteMessage(email, gone);
    await drainMailboxJobs({ ...deps, limits: { ...deps.limits, maxFileBytes: 10 } }, tenantId);
    const rows = await ledger(tenantId);
    expect(rows.find((r) => r.provider_message_id === gone)).toMatchObject({ status: "skipped", reason: "deleted" });
    expect(rows.find((r) => r.provider_message_id === big)).toMatchObject({ status: "skipped", reason: "too_large" });
    expect(await docs(tenantId)).toEqual([]);
  });

  it("defers mail over the tenant's inbound limit instead of dropping it", async () => {
    const { tenantId, email, connectionId } = await connected();
    google.deliver(email, eml("limited"));
    await sync(tenantId, connectionId);
    await drainMailboxJobs({ ...deps, limits: { ...deps.limits, inboundPerHour: 0 } }, tenantId);
    expect((await ledger(tenantId))[0]?.status).toBe("deferred");
    const later = await boss.findJobs(QUEUES.mailboxFetch, { data: { tenantId }, queued: true });
    expect(later).toHaveLength(1);
    await boss.deleteJob(
      QUEUES.mailboxFetch,
      later.map((j) => j.id),
    );
  });

  it("keeps a purged document's message as a tombstone, so a resync doesn't ingest it again", async () => {
    const { tenantId, email, connectionId } = await connected();
    google.deliver(email, eml("purge-me"));
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);
    const [doc] = await docs(tenantId);
    await withTenantTx(pool, tenantId, (tx) => purgeDocument(tx, boss, doc?.id ?? ""));
    expect((await ledger(tenantId))[0]).toMatchObject({ status: "purged", document_id: null });

    google.expireHistory(email);
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);
    expect(await docs(tenantId)).toEqual([]);
  });

  it("records the mailbox as the sender's provenance, which an eval snapshot keeps", async () => {
    const { tenantId, email, connectionId } = await connected();
    const trace =
      "Received: from mail.vendor.test (mail.vendor.test. [203.0.113.5])\r\n        by mx.google.com with ESMTPS id a1; Tue, 3 Nov 2026 02:00:00 -0800\r\n" +
      "Authentication-Results: mx.google.com; dkim=pass header.i=@vendor.test; dmarc=pass header.from=vendor.test\r\n" +
      "Authentication-Results: mx.google.com; dmarc=fail (forged below Google's trace)\r\n";
    google.deliver(email, `${trace}${eml("signed")}`);
    await sync(tenantId, connectionId);
    await drainMailboxJobs(deps, tenantId);
    const [row] = await tenantQuery<{ source_key: string; mime: string; title: string; external_id: string }>(
      pool,
      tenantId,
      "select source_key, mime, title, external_id from documents",
    );
    if (!row) throw new Error("no document");
    const sender = await loadSender(deps.storage, { sourceKey: row.source_key, mime: row.mime, title: row.title });
    expect(sender).toEqual({
      authResults: ["mx.google.com; dkim=pass header.i=@vendor.test; dmarc=pass header.from=vendor.test"],
      receivedBy: "google",
    });
    const snapshot = await snapshotDocumentSource(deps.storage, tenantId, {
      sourceKey: row.source_key,
      mime: row.mime,
      title: row.title,
      externalId: row.external_id,
    });
    expect(
      await loadSender(deps.storage, {
        sourceKey: snapshot.sourceKey,
        mime: snapshot.sourceMime,
        title: snapshot.sourceTitle,
      }),
    ).toEqual(sender);
  });
});
