import { describe, expect, it } from "vitest";
import type { GoogleConfig } from "../config";
import {
  HistoryExpiredError,
  MailboxApiError,
  MailboxAuthError,
  MailboxRateLimitError,
  MessageGoneError,
} from "../errors";
import { FakeGoogle } from "../testing/fake-google";
import { getMessageMeta, getProfile, getRawMessage, listHistory, listLabels, listMessages } from "./gmail";
import {
  authorizationUrl,
  exchangeCode,
  GMAIL_READONLY_SCOPE,
  idTokenClaims,
  MAILBOX_SCOPES,
  pkcePair,
  refreshAccessToken,
  revokeToken,
} from "./oauth";

const config: GoogleConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  oauthUrl: "https://accounts.google.com",
  tokenUrl: "https://oauth2.googleapis.com",
  apiUrl: "https://gmail.googleapis.com",
};
const REDIRECT = "https://api.example.test/integrations/google/callback";

function setup() {
  const google = new FakeGoogle(config);
  google.addMailbox("ap@acme.test", { hd: "acme.test" });
  return { google, deps: { config, fetch: google.fetch } };
}

/** Runs the consent round trip and the code exchange, as the callback does. */
async function connect(google: FakeGoogle, deps: { config: GoogleConfig; fetch: typeof fetch }, scopes?: string[]) {
  const { verifier, challenge } = pkcePair();
  const url = authorizationUrl(deps, {
    state: "state-1",
    codeChallenge: challenge,
    redirectUri: REDIRECT,
    scopes: MAILBOX_SCOPES,
    offline: true,
  });
  const back = new URL(google.consent(url, scopes ? { scopes } : {}));
  expect(back.searchParams.get("state")).toBe("state-1");
  return exchangeCode(deps, {
    code: back.searchParams.get("code") ?? "",
    codeVerifier: verifier,
    redirectUri: REDIRECT,
  });
}

const raw = (subject: string) =>
  `From: Vendor <billing@vendor.test>\r\nTo: ap@acme.test\r\nSubject: ${subject}\r\nMessage-ID: <${subject}@vendor.test>\r\n\r\nHello\r\n`;

describe("Google OAuth", () => {
  it("asks for an offline grant with PKCE and exactly the mailbox scopes", () => {
    const url = new URL(
      authorizationUrl(
        { config },
        { state: "s", codeChallenge: "c", redirectUri: REDIRECT, scopes: MAILBOX_SCOPES, offline: true },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "client-id",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `openid email ${GMAIL_READONLY_SCOPE}`,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
  });

  it("exchanges the code for a refresh token and the granted scopes, and refreshes", async () => {
    const { google, deps } = setup();
    const tokens = await connect(google, deps);
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.scopes).toContain(GMAIL_READONLY_SCOPE);
    expect(idTokenClaims(tokens.idToken ?? "")).toMatchObject({ email: "ap@acme.test", hd: "acme.test" });
    const refreshed = await refreshAccessToken(deps, tokens.refreshToken ?? "");
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
  });

  it("refuses a code exchanged without the right PKCE verifier", async () => {
    const { google, deps } = setup();
    const { challenge } = pkcePair();
    const url = authorizationUrl(deps, {
      state: "s",
      codeChallenge: challenge,
      redirectUri: REDIRECT,
      scopes: MAILBOX_SCOPES,
      offline: true,
    });
    const code = new URL(google.consent(url)).searchParams.get("code") ?? "";
    await expect(
      exchangeCode(deps, { code, codeVerifier: pkcePair().verifier, redirectUri: REDIRECT }),
    ).rejects.toThrow(MailboxAuthError);
  });

  it("turns a revoked grant into MailboxAuthError, and revokes idempotently", async () => {
    const { google, deps } = setup();
    const tokens = await connect(google, deps);
    await revokeToken(deps, tokens.refreshToken ?? "");
    await revokeToken(deps, tokens.refreshToken ?? "");
    await expect(refreshAccessToken(deps, tokens.refreshToken ?? "")).rejects.toThrow(MailboxAuthError);
  });
});

describe("Gmail", () => {
  it("reads the profile, labels, and new mail through history", async () => {
    const { google, deps } = setup();
    const { accessToken } = await connect(google, deps);
    const profile = await getProfile(deps, accessToken);
    expect(profile.emailAddress).toBe("ap@acme.test");
    expect((await listLabels(deps, accessToken)).map((l) => l.name)).toContain("Triage");

    const first = google.deliver("ap@acme.test", raw("one"));
    google.deliver("ap@acme.test", raw("spam"), ["SPAM"]);
    const filed = google.deliver("ap@acme.test", raw("filed"), ["Label_1"]);
    google.addLabel("ap@acme.test", first, "Label_1");

    const inbox = await listHistory(deps, accessToken, { startHistoryId: profile.historyId, labelId: "INBOX" });
    expect(inbox.messageIds).toEqual([first]);
    const triage = await listHistory(deps, accessToken, { startHistoryId: profile.historyId, labelId: "Label_1" });
    expect(triage.messageIds).toEqual([filed, first]);
    expect(Number(triage.historyId)).toBeGreaterThan(Number(profile.historyId));

    const message = await getRawMessage(deps, accessToken, first);
    expect(new TextDecoder().decode(message.raw)).toContain("Subject: one");
    expect((await getMessageMeta(deps, accessToken, first)).labelIds).toContain("INBOX");
    expect(await listMessages(deps, accessToken, { labelId: "INBOX", q: "newer_than:1d", max: 10 })).toEqual([first]);
  });

  it("pages through history", async () => {
    const { google, deps } = setup();
    const { accessToken } = await connect(google, deps);
    const start = (await getProfile(deps, accessToken)).historyId;
    const ids = [1, 2, 3].map((n) => google.deliver("ap@acme.test", raw(`m${n}`)));
    const page = await listHistory(deps, accessToken, { startHistoryId: start, labelId: "INBOX", maxResults: 2 });
    expect(page.messageIds).toEqual(ids.slice(0, 2));
    const rest = await listHistory(deps, accessToken, {
      startHistoryId: start,
      labelId: "INBOX",
      pageToken: page.nextPageToken,
    });
    expect(rest.messageIds).toEqual(ids.slice(2));
    expect(rest.nextPageToken).toBeNull();
  });

  it("maps expired history, deleted messages, refused tokens and rate limits", async () => {
    const { google, deps } = setup();
    const { accessToken } = await connect(google, deps);
    const start = (await getProfile(deps, accessToken)).historyId;
    google.expireHistory("ap@acme.test");
    await expect(listHistory(deps, accessToken, { startHistoryId: start, labelId: "INBOX" })).rejects.toThrow(
      HistoryExpiredError,
    );
    await expect(getRawMessage(deps, accessToken, "missing")).rejects.toThrow(MessageGoneError);
    await expect(getProfile(deps, "not-a-token")).rejects.toThrow(MailboxAuthError);

    const limited = { config, fetch: async () => new Response("{}", { status: 429, headers: { "retry-after": "7" } }) };
    await expect(getProfile(limited, accessToken)).rejects.toMatchObject({ retryAfterSeconds: 7 });
    await expect(getProfile(limited, accessToken)).rejects.toBeInstanceOf(MailboxRateLimitError);
    const down = { config, fetch: async () => new Response("oops", { status: 503 }) };
    await expect(getProfile(down, accessToken)).rejects.toMatchObject({ status: 503 });
    await expect(getProfile(down, accessToken)).rejects.toBeInstanceOf(MailboxApiError);
  });

  it("refuses Gmail when the user unticked the Gmail scope", async () => {
    const { google, deps } = setup();
    const tokens = await connect(google, deps, ["openid", "email"]);
    expect(tokens.scopes).not.toContain(GMAIL_READONLY_SCOPE);
    await expect(getProfile(deps, tokens.accessToken)).rejects.toMatchObject({ status: 403 });
  });
});
