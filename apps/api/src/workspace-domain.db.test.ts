import { randomUUID } from "node:crypto";
import { MemberList, MeResponse } from "@ai-triage/contracts";
import { createTenant } from "@ai-triage/db";
import { FakeGoogle } from "@ai-triage/mailbox/testing";
import { afterAll, describe, expect, it } from "vitest";
import { createTestApp, TEST_GOOGLE, WEB_ORIGIN } from "./test-app";
import { googleProfile, stubGoogle } from "./test-google";

// Workspace domain auto-join (phase 6, M5). Claiming a domain takes a Google Workspace account in
// it (the fake Google's consent screen answers the domain check); signing up through it takes a
// Google sign-in whose `hd` is that domain (Better Auth's token endpoint is stubbed).

const google = new FakeGoogle(TEST_GOOGLE);
const t = await createTestApp({ google: TEST_GOOGLE, googleFetch: google.fetch });
const { app, pool } = t;
afterAll(t.close);
const { viaGoogle, sessionOf } = stubGoogle(app);

const json = (method: string, path: string, body: unknown, cookie: string) =>
  app.request(path, {
    method,
    headers: { "content-type": "application/json", origin: WEB_ORIGIN, cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function workspace() {
  const { id: tenantId } = await createTenant(pool, { name: "Corp", slug: `corp-${randomUUID().slice(0, 8)}` });
  return { tenantId, admin: await t.memberCookie(tenantId, "admin") };
}

/** The admin proves a domain by consenting as `email` on the fake Google. */
async function claim(admin: string, email: string, joinRole = "viewer") {
  const start = await json("POST", "/members/workspace-domain/verify", { joinRole }, admin);
  const { url } = (await start.json()) as { url: string };
  expect(new URL(url).searchParams.get("hd")).toBe("*");
  const back = new URL(google.consent(url, { email }));
  const res = await app.request(`${back.pathname}${back.search}`, { headers: { cookie: admin } });
  const location = new URL(res.headers.get("location") ?? "");
  expect(`${location.origin}${location.pathname}`).toBe(`${WEB_ORIGIN}/settings/members`);
  return { domain: location.searchParams.get("domain"), error: location.searchParams.get("error") };
}

const newDomain = () => `corp-${randomUUID().slice(0, 8)}.test`;
const members = async (cookie: string) =>
  MemberList.parse(await (await app.request("/members", { headers: { cookie } })).json());

describe("Workspace domain auto-join", () => {
  it("is claimed with a Workspace account in the domain, once per domain", async () => {
    const { admin } = await workspace();
    const domain = newDomain();
    google.addMailbox(`it@${domain}`, { hd: domain });
    expect(await claim(admin, `it@${domain}`, "reviewer")).toEqual({ domain, error: null });
    expect((await members(admin)).workspaceDomain).toEqual({ domain, joinRole: "reviewer" });

    const other = await workspace();
    expect((await claim(other.admin, `it@${domain}`)).error).toBe("domain_taken");
  });

  it("can't be claimed with a consumer Google account", async () => {
    const { admin } = await workspace();
    google.addMailbox(`someone-${randomUUID().slice(0, 6)}@gmail.test`);
    const result = await claim(admin, [...google.mailboxes.keys()].at(-1) ?? "");
    expect(result.error).toBe("not_workspace_account");
    expect((await members(admin)).workspaceDomain).toBeNull();
  });

  it("lets a new person from the domain in on their first Google sign-in, as the join role", async () => {
    const { tenantId, admin } = await workspace();
    const domain = newDomain();
    google.addMailbox(`it@${domain}`, { hd: domain });
    await claim(admin, `it@${domain}`);

    const email = `newhire@${domain}`;
    const account = googleProfile(email, { hd: domain });
    const signIn = await viaGoogle(account);
    expect(signIn.location).toBe(`${WEB_ORIGIN}/`);
    expect((await sessionOf(signIn.cookie))?.session.activeOrganizationId).toBe(tenantId);
    const me = MeResponse.parse(await (await app.request("/me", { headers: { cookie: signIn.cookie } })).json());
    expect(me).toMatchObject({ tenant: { id: tenantId }, role: "viewer" });
    const listed = await members(admin);
    expect(listed.members.find((m) => m.email === email)).toMatchObject({ hostedDomain: domain });

    // Removed, they don't come back by signing in again.
    const target = listed.members.find((m) => m.email === email);
    expect((await json("DELETE", `/members/${target?.userId}`, undefined, admin)).status).toBe(204);
    const again = await viaGoogle(account);
    expect((await app.request("/me", { headers: { cookie: again.cookie } })).status).toBe(403);
  });

  it("takes the domain from Google's hd claim, never from the email address", async () => {
    const { admin } = await workspace();
    const domain = newDomain();
    google.addMailbox(`it@${domain}`, { hd: domain });
    await claim(admin, `it@${domain}`);
    const signIn = await viaGoogle(googleProfile(`outsider@${domain}`));
    expect(new URL(signIn.location).searchParams.get("error")).toBe("not_invited");
  });

  it("changes the join role and unlinks the domain", async () => {
    const { admin } = await workspace();
    const domain = newDomain();
    google.addMailbox(`it@${domain}`, { hd: domain });
    await claim(admin, `it@${domain}`);
    expect((await json("PATCH", "/members/workspace-domain", { joinRole: "reviewer" }, admin)).status).toBe(204);
    expect((await members(admin)).workspaceDomain?.joinRole).toBe("reviewer");
    expect((await json("DELETE", "/members/workspace-domain", undefined, admin)).status).toBe(204);
    expect((await members(admin)).workspaceDomain).toBeNull();
    expect((await json("PATCH", "/members/workspace-domain", { joinRole: "viewer" }, admin)).status).toBe(404);
  });
});
