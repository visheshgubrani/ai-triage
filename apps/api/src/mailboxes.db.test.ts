import { randomUUID } from "node:crypto";
import { MailboxDetail, MailboxLabels, MailboxList, MailboxSummary } from "@ai-triage/contracts";
import {
  addMembership,
  createTenant,
  ensurePasswordUser,
  listAuditEvents,
  markReauthRequired,
  withTenantTx,
} from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { tenantQuery } from "@ai-triage/db/testing";
import { type Consent, FakeGoogle } from "@ai-triage/mailbox/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, TEST_GOOGLE, WEB_ORIGIN } from "./test-app";

// Mailbox connections (phase 6, M3) against a fake Google: the OAuth round trip (state used once,
// by the admin who started it, within ten minutes), the granted scopes, encrypted tokens, labels,
// reconnecting, and disconnecting (revoked at Google, forgotten here).

const google = new FakeGoogle(TEST_GOOGLE);
const t = await createTestApp({ google: TEST_GOOGLE, googleFetch: google.fetch });
const { app, pool } = t;
afterAll(t.close);

const json = (method: string, path: string, body: unknown, cookie: string) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function workspace() {
  const { id: tenantId } = await createTenant(pool, { name: "Box", slug: `box-${randomUUID().slice(0, 8)}` });
  return { tenantId, admin: await t.memberCookie(tenantId, "admin") };
}

const newMailbox = () => google.addMailbox(`ap-${randomUUID().slice(0, 8)}@acme.test`).email;

/** Starts a connection, lets the fake consent screen answer, and follows Google's redirect back. */
async function connect(cookie: string, consent: Consent, body: Record<string, unknown> = {}) {
  const start = await json("POST", "/mailboxes/google/authorize", body, cookie);
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  return callback(google.consent(url, consent), cookie);
}

async function callback(googleRedirect: string, cookie: string) {
  const back = new URL(googleRedirect);
  expect(`${back.origin}${back.pathname}`).toBe("http://localhost:3000/api/integrations/google/callback");
  const res = await app.request(`${back.pathname}${back.search}`, { headers: { cookie } });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${WEB_ORIGIN}/settings/mailboxes`);
  return { connected: location.searchParams.get("connected"), error: location.searchParams.get("error") };
}

// biome-ignore lint/suspicious/noExplicitAny: raw rows, checked with toMatchObject
type Row = Record<string, any>;
const connectionRow = async (tenantId: string, id: string) =>
  (await tenantQuery<Row>(pool, tenantId, "select * from mailbox_connections where id = $1", [id]))[0];

describe("connecting a Google mailbox", () => {
  it("stores the grant encrypted and audits it, without the tokens", async () => {
    const { tenantId, admin } = await workspace();
    const email = newMailbox();
    const { connected, error } = await connect(admin, { email }, { backfillDays: 3 });
    expect(error).toBeNull();

    const list = MailboxList.parse(await (await app.request("/mailboxes", { headers: { cookie: admin } })).json());
    expect(list.mailboxes).toMatchObject([
      { id: connected, email, status: "active", labelId: "INBOX", provider: "google" },
    ]);

    const row = await connectionRow(tenantId, connected ?? "");
    expect(row?.refresh_token_enc).toMatch(/^v1:/);
    expect(row?.refresh_token_enc).not.toContain("fake-refresh");
    expect(row?.history_id).toBe("1000");
    expect(row?.backfill_days).toBe(3);
    expect(row?.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");

    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 5 }));
    expect(events[0]).toMatchObject({ action: "mailbox.connected", targetId: connected });
    expect(JSON.stringify(events[0]?.details)).not.toMatch(/ya29|1\/\/|refresh/);
  });

  it("uses a state once, only for the admin who started it, within ten minutes", async () => {
    const { tenantId, admin } = await workspace();
    const email = newMailbox();
    const start = await json("POST", "/mailboxes/google/authorize", {}, admin);
    const { url } = (await start.json()) as { url: string };
    const redirect = google.consent(url, { email });

    // Another admin of the same tenant can't finish someone else's round trip.
    const otherEmail = `other-admin-${randomUUID().slice(0, 8)}@test.test`;
    await addMembership(
      t.db,
      await ensurePasswordUser(t.db, { email: otherEmail, name: "Other", password: DEMO_PASSWORD }),
      tenantId,
      "admin",
    );
    const otherAdmin = (await t.signIn(otherEmail)).cookie;
    expect((await callback(redirect, otherAdmin)).error).toBe("state_invalid");

    expect((await callback(redirect, admin)).connected).toBeTruthy();
    expect((await callback(redirect, admin)).error).toBe("state_invalid");

    const late = await json("POST", "/mailboxes/google/authorize", {}, admin);
    const lateRedirect = google.consent(((await late.json()) as { url: string }).url, { email });
    t.setNow(new Date(Date.now() + 11 * 60_000));
    try {
      expect((await callback(lateRedirect, admin)).error).toBe("state_invalid");
    } finally {
      t.setNow(null);
    }
  });

  it("can't finish another tenant's round trip", async () => {
    const a = await workspace();
    const b = await workspace();
    const start = await json("POST", "/mailboxes/google/authorize", {}, a.admin);
    const redirect = google.consent(((await start.json()) as { url: string }).url, { email: newMailbox() });
    expect((await callback(redirect, b.admin)).error).toBe("state_invalid");
  });

  it("reports a denied consent, and refuses (and revokes) a grant without Gmail access", async () => {
    const { admin } = await workspace();
    expect((await connect(admin, { deny: true })).error).toBe("access_denied");
    const before = google.revoked.length;
    expect((await connect(admin, { email: newMailbox(), scopes: ["openid", "email"] })).error).toBe("scope_missing");
    expect(google.revoked.length).toBe(before + 1);
  });

  it("is admin-only", async () => {
    const { tenantId } = await workspace();
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    expect((await json("POST", "/mailboxes/google/authorize", {}, reviewer)).status).toBe(403);
    expect((await app.request("/mailboxes", { headers: { cookie: reviewer } })).status).toBe(403);
  });

  it("reconnects the same mailbox in place, keeping its cursor after a lost grant", async () => {
    const { tenantId, admin } = await workspace();
    const email = newMailbox();
    const first = await connect(admin, { email });
    const id = first.connected ?? "";
    await tenantQuery(pool, tenantId, "update mailbox_connections set history_id = '1234' where id = $1", [id]);
    await withTenantTx(pool, tenantId, (tx) => markReauthRequired(tx, id, new Date()));
    const lost = MailboxDetail.parse(
      await (await app.request(`/mailboxes/${id}`, { headers: { cookie: admin } })).json(),
    );
    expect(lost.mailbox.status).toBe("reauth_required");

    const again = await connect(admin, { email }, { loginHint: email });
    expect(again.connected).toBe(id);
    expect(await connectionRow(tenantId, id)).toMatchObject({ status: "active", history_id: "1234", last_error: null });
  });
});

describe("a connected mailbox", () => {
  it("lists labels and changes the intake label", async () => {
    const { admin } = await workspace();
    const { connected } = await connect(admin, { email: newMailbox() });
    const labels = MailboxLabels.parse(
      await (await app.request(`/mailboxes/${connected}/labels`, { headers: { cookie: admin } })).json(),
    );
    expect(labels.labels.map((l) => l.name)).toEqual(expect.arrayContaining(["INBOX", "Triage"]));
    expect(labels.labels.map((l) => l.id)).not.toContain("SPAM");

    const changed = await json("PATCH", `/mailboxes/${connected}`, { labelId: "Label_1" }, admin);
    expect(MailboxSummary.parse(await changed.json())).toMatchObject({ labelId: "Label_1", labelName: "Triage" });
    expect((await json("PATCH", `/mailboxes/${connected}`, { labelId: "Label_404" }, admin)).status).toBe(422);

    const paused = await json("PATCH", `/mailboxes/${connected}`, { paused: true }, admin);
    expect(MailboxSummary.parse(await paused.json()).status).toBe("paused");
  });

  it("says to reconnect when Google refuses the grant", async () => {
    const { tenantId, admin } = await workspace();
    const email = newMailbox();
    const { connected } = await connect(admin, { email });
    google.revokeGrants(email);
    await tenantQuery(pool, tenantId, "update mailbox_connections set access_token_expires_at = now() where id = $1", [
      connected,
    ]);
    expect((await app.request(`/mailboxes/${connected}/labels`, { headers: { cookie: admin } })).status).toBe(409);
    expect((await connectionRow(tenantId, connected ?? ""))?.status).toBe("reauth_required");
  });

  it("disconnects: the token is revoked at Google and forgotten here", async () => {
    const { tenantId, admin } = await workspace();
    const { connected } = await connect(admin, { email: newMailbox() });
    const before = google.revoked.length;
    expect((await json("DELETE", `/mailboxes/${connected}`, undefined, admin)).status).toBe(204);
    expect(google.revoked.length).toBe(before + 1);
    expect(await connectionRow(tenantId, connected ?? "")).toMatchObject({
      status: "disconnected",
      refresh_token_enc: null,
      access_token_enc: null,
      history_id: null,
    });
    const list = MailboxList.parse(await (await app.request("/mailboxes", { headers: { cookie: admin } })).json());
    expect(list.mailboxes).toEqual([]);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 1 }));
    expect(events[0]).toMatchObject({ action: "mailbox.disconnected", details: { revokedAtProvider: true } });
    expect((await json("DELETE", `/mailboxes/${connected}`, undefined, admin)).status).toBe(404);
  });
});
