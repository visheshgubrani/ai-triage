import { randomUUID } from "node:crypto";
import {
  ErrorResponse,
  InvitationAccepted,
  InvitationCreated,
  InvitationPreview,
  MemberList,
  MeResponse,
} from "@ai-triage/contracts";
import { addMembership, createTenant, ensurePasswordUser, listAuditEvents, withTenantTx } from "@ai-triage/db";
import { DEMO_PASSWORD } from "@ai-triage/db/seed";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, TEST_GOOGLE, WEB_ORIGIN } from "./test-app";
import { googleProfile, stubGoogle } from "./test-google";

// Members and invitations (phase 6, M2): invitation links (single use, expiring, revocable, only a
// hash stored), accepting with Google or a password, the last-admin guard, and removal taking
// effect on the next request. Google is stubbed (test-google.ts).

const t = await createTestApp({ google: TEST_GOOGLE });
const { app, db, pool } = t;
afterAll(t.close);
const { viaGoogle, sessionOf } = stubGoogle(app);

const json = (method: string, path: string, body: unknown, cookie = "") =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function workspace() {
  const { id: tenantId } = await createTenant(pool, { name: "Team", slug: `team-${randomUUID().slice(0, 8)}` });
  const admin = await t.memberCookie(tenantId, "admin");
  return { tenantId, admin };
}

async function invite(admin: string, email: string, role = "reviewer", acceptWith = "google") {
  const res = await json("POST", "/members/invitations", { email, role, acceptWith }, admin);
  expect(res.status).toBe(201);
  const created = InvitationCreated.parse(await res.json());
  const token = new URL(created.link).hash.slice(1);
  expect(created.link).toBe(`${WEB_ORIGIN}/invite#${token}`);
  return { ...created, token };
}

const newEmail = () => `person-${randomUUID().slice(0, 8)}@test.test`;

describe("invitations", () => {
  it("stores only a hash of the token, and shows the invitation by token", async () => {
    const { admin } = await workspace();
    const email = newEmail();
    const { token, invitation } = await invite(admin, email);
    const { rows } = await pool.query("select token_hash from invitations where id = $1", [invitation.id]);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].token_hash).not.toContain(token);

    const preview = await json("POST", "/invitations/lookup", { token });
    expect(InvitationPreview.parse(await preview.json())).toMatchObject({
      tenantName: "Team",
      email,
      role: "reviewer",
      acceptWith: "google",
      google: true,
    });
  });

  it("lets a new person in with Google: the user exists only while an invitation does, and joins on accept", async () => {
    const { tenantId, admin } = await workspace();
    const email = newEmail();
    const { token } = await invite(admin, email);

    const signIn = await viaGoogle(googleProfile(email), { callbackPath: "/invite" });
    expect(signIn.location).toBe(`${WEB_ORIGIN}/invite`);
    const session = await sessionOf(signIn.cookie);
    expect(session?.user.email).toBe(email);
    // Signed in, but not a member until the invite page accepts.
    expect((await app.request("/me", { headers: { cookie: signIn.cookie } })).status).toBe(403);

    const accepted = await json("POST", "/invitations/accept", { token }, signIn.cookie);
    expect(InvitationAccepted.parse(await accepted.json())).toMatchObject({ tenantId, email });
    const me = MeResponse.parse(await (await app.request("/me", { headers: { cookie: signIn.cookie } })).json());
    expect(me).toMatchObject({ tenant: { id: tenantId }, role: "reviewer" });

    // Single use.
    const again = await json("POST", "/invitations/accept", { token }, signIn.cookie);
    expect(again.status).toBe(410);
    expect(ErrorResponse.parse(await again.json()).code).toBe("invitation_invalid");
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 20 }));
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["member.invited", "member.joined"]));
  });

  it("refuses an invitation for someone else's email", async () => {
    const { admin } = await workspace();
    const { token } = await invite(admin, newEmail());
    const other = newEmail();
    const { admin: otherAdmin } = await workspace();
    await invite(otherAdmin, other); // so Google may create this user at all
    const signIn = await viaGoogle(googleProfile(other));
    const res = await json("POST", "/invitations/accept", { token }, signIn.cookie);
    expect(res.status).toBe(403);
    expect(ErrorResponse.parse(await res.json()).code).toBe("email_mismatch");
  });

  it("replaces a pending invitation when the same email is invited again, and can revoke", async () => {
    const { admin } = await workspace();
    const email = newEmail();
    const first = await invite(admin, email);
    const second = await invite(admin, email, "viewer");
    expect((await json("POST", "/invitations/lookup", { token: first.token })).status).toBe(410);
    expect((await json("POST", "/invitations/lookup", { token: second.token })).status).toBe(200);

    const listed = MemberList.parse(await (await app.request("/members", { headers: { cookie: admin } })).json());
    expect(listed.invitations.map((i) => i.email)).toEqual([email]);

    expect((await json("POST", `/members/invitations/${second.invitation.id}/revoke`, undefined, admin)).status).toBe(
      204,
    );
    expect((await json("POST", "/invitations/lookup", { token: second.token })).status).toBe(410);
    // Without an invitation, Google doesn't create the user any more.
    const signIn = await viaGoogle(googleProfile(email));
    expect(new URL(signIn.location).searchParams.get("error")).toBe("not_invited");
  });

  it("expires after seven days", async () => {
    const { admin } = await workspace();
    const { token } = await invite(admin, newEmail());
    t.setNow(new Date(Date.now() + 8 * 86_400_000));
    try {
      expect((await json("POST", "/invitations/lookup", { token })).status).toBe(410);
    } finally {
      t.setNow(null);
    }
  });

  it("accepts with a password only when the invitation allows it, creating an unverified user", async () => {
    const { tenantId, admin } = await workspace();
    const googleOnly = await invite(admin, newEmail());
    const refused = await json("POST", "/invitations/accept-password", {
      token: googleOnly.token,
      name: "Pat",
      password: "a-long-enough-password",
    });
    expect(ErrorResponse.parse(await refused.json()).code).toBe("password_not_allowed");

    const email = newEmail();
    const { token } = await invite(admin, email, "viewer", "google_or_password");
    const res = await json("POST", "/invitations/accept-password", {
      token,
      name: "Pat",
      password: "a-long-enough-password",
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query("select email_verified from users where email = $1", [email]);
    expect(rows[0].email_verified).toBe(false);
    const signIn = await t.signIn(email, "a-long-enough-password");
    const me = MeResponse.parse(await (await app.request("/me", { headers: { cookie: signIn.cookie } })).json());
    expect(me).toMatchObject({ tenant: { id: tenantId }, role: "viewer" });
  });

  it("won't create a second account for an email that has one", async () => {
    const { admin } = await workspace();
    const email = newEmail();
    await ensurePasswordUser(db, { email, name: "Existing", password: DEMO_PASSWORD });
    const { token } = await invite(admin, email, "viewer", "google_or_password");
    const res = await json("POST", "/invitations/accept-password", {
      token,
      name: "X",
      password: "a-long-enough-password",
    });
    expect(res.status).toBe(409);
    expect(ErrorResponse.parse(await res.json()).code).toBe("user_exists");

    // They sign in to their account and accept there instead.
    const signIn = await t.signIn(email);
    expect((await json("POST", "/invitations/accept", { token }, signIn.cookie)).status).toBe(200);
  });

  it("refuses to invite an existing member", async () => {
    const { tenantId, admin } = await workspace();
    const email = newEmail();
    const userId = await ensurePasswordUser(db, { email, name: "M", password: DEMO_PASSWORD });
    await addMembership(db, userId, tenantId, "viewer");
    const res = await json("POST", "/members/invitations", { email, role: "viewer" }, admin);
    expect(ErrorResponse.parse(await res.json()).code).toBe("already_member");
  });
});

describe("members", () => {
  it("lists members with their sign-in methods, and changes roles", async () => {
    const { tenantId, admin } = await workspace();
    const reviewer = await t.memberCookie(tenantId, "reviewer");
    const listed = MemberList.parse(await (await app.request("/members", { headers: { cookie: admin } })).json());
    expect(listed.members.map((m) => m.role).sort()).toEqual(["admin", "reviewer"]);
    expect(listed.members[0]?.signInMethods).toEqual(["credential"]);

    const target = listed.members.find((m) => m.role === "reviewer");
    expect((await json("PATCH", `/members/${target?.userId}`, { role: "viewer" }, admin)).status).toBe(204);
    const me = MeResponse.parse(await (await app.request("/me", { headers: { cookie: reviewer } })).json());
    expect(me.role).toBe("viewer");
    // Members admin is admin-only.
    expect((await app.request("/members", { headers: { cookie: reviewer } })).status).toBe(403);
  });

  it("keeps at least one admin", async () => {
    const { admin } = await workspace();
    const listed = MemberList.parse(await (await app.request("/members", { headers: { cookie: admin } })).json());
    const self = listed.members[0];
    const demote = await json("PATCH", `/members/${self?.userId}`, { role: "viewer" }, admin);
    expect(demote.status).toBe(409);
    expect(ErrorResponse.parse(await demote.json()).code).toBe("last_admin");
    expect((await json("DELETE", `/members/${self?.userId}`, undefined, admin)).status).toBe(409);
  });

  it("removes a member, whose next request has no access", async () => {
    const { tenantId, admin } = await workspace();
    const viewer = await t.memberCookie(tenantId, "viewer");
    const listed = MemberList.parse(await (await app.request("/members", { headers: { cookie: admin } })).json());
    const target = listed.members.find((m) => m.role === "viewer");
    expect((await json("DELETE", `/members/${target?.userId}`, undefined, admin)).status).toBe(204);
    expect((await app.request("/me", { headers: { cookie: viewer } })).status).toBe(403);
    const { events } = await withTenantTx(pool, tenantId, (tx) => listAuditEvents(tx, { limit: 5 }));
    expect(events[0]).toMatchObject({ action: "member.removed", targetId: target?.userId });
  });

  it("can't reach another tenant's members", async () => {
    const a = await workspace();
    const b = await workspace();
    const bMembers = MemberList.parse(await (await app.request("/members", { headers: { cookie: b.admin } })).json());
    const bAdmin = bMembers.members[0];
    const res = await json("DELETE", `/members/${bAdmin?.userId}`, undefined, a.admin);
    expect(res.status).toBe(404);
    const invitationB = await invite(b.admin, newEmail());
    expect(
      (await json("POST", `/members/invitations/${invitationB.invitation.id}/revoke`, undefined, a.admin)).status,
    ).toBe(410);
  });
});
