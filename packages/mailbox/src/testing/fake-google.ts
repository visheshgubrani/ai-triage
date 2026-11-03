import { createHash, randomBytes } from "node:crypto";
import { GMAIL_READONLY_SCOPE } from "../google/oauth";

// A fake Google for tests and the local demo: the OAuth consent, token and revoke endpoints, and
// the Gmail calls mailbox sync makes, over in-memory mailboxes. `fake.fetch` drops in wherever a
// GoogleDeps `fetch` goes; the demo serves `fake.handle` over HTTP (infra/fake-google). It checks
// what Google checks that matters here: the client, the redirect URI, PKCE, single-use codes,
// revoked grants, and history older than what Gmail keeps.

interface FakeMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  raw: Uint8Array;
  internalDate: number;
}

interface HistoryRecord {
  id: number;
  messagesAdded?: { message: { id: string; labelIds: string[] } }[];
  labelsAdded?: { message: { id: string; labelIds: string[] }; labelIds: string[] }[];
}

export interface FakeMailbox {
  email: string;
  sub: string;
  /** Workspace domain (`hd`), or null for a consumer account. */
  hd: string | null;
  historyId: number;
  /** History before this id is gone (history.list 404s). */
  oldestHistoryId: number;
  messages: Map<string, FakeMessage>;
  history: HistoryRecord[];
  labels: { id: string; name: string; type: "system" | "user" }[];
}

interface Grant {
  email: string;
  scopes: string[];
}

/** What the person on the consent screen does next. Default: grant every scope as the first mailbox. */
export interface Consent {
  email?: string;
  /** Untick scopes (Google's granular consent): grant only these. */
  scopes?: string[];
  deny?: boolean;
}

const SYSTEM_LABELS = ["INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "IMPORTANT", "CHAT"];

const json = (body: unknown, status = 200) => Response.json(body, { status });
const googleError = (status: number, error: string) => json({ error, error_description: error }, status);
const token = (prefix: string) => `${prefix}${randomBytes(16).toString("base64url")}`;

export class FakeGoogle {
  readonly mailboxes = new Map<string, FakeMailbox>();
  /** Tokens revoked through /revoke, in order. */
  readonly revoked: string[] = [];
  /** Requests served, as `METHOD path` (for asserting what was called). */
  readonly calls: string[] = [];
  nextConsent: Consent = {};
  private readonly codes = new Map<string, Grant & { challenge: string; redirectUri: string; offline: boolean }>();
  private readonly refreshTokens = new Map<string, Grant>();
  private readonly accessTokens = new Map<string, Grant & { expiresAt: number }>();
  private nextId = 1;

  constructor(
    readonly client: { clientId: string; clientSecret: string },
    private readonly now: () => number = Date.now,
  ) {}

  /** Adds a mailbox (an account that can consent), with Gmail's system labels and a `Triage` label. */
  addMailbox(email: string, options: { hd?: string } = {}): FakeMailbox {
    const mailbox: FakeMailbox = {
      email: email.toLowerCase(),
      sub: `fake-${createHash("sha256").update(email).digest("hex").slice(0, 16)}`,
      hd: options.hd ?? null,
      historyId: 1000,
      oldestHistoryId: 1,
      messages: new Map(),
      history: [],
      labels: [
        ...SYSTEM_LABELS.map((id) => ({ id, name: id, type: "system" as const })),
        { id: "Label_1", name: "Triage", type: "user" as const },
      ],
    };
    this.mailboxes.set(mailbox.email, mailbox);
    return mailbox;
  }

  private mailbox(email: string): FakeMailbox {
    const mailbox = this.mailboxes.get(email.toLowerCase());
    if (!mailbox) throw new Error(`fake Google has no mailbox ${email}`);
    return mailbox;
  }

  /** Mail arrives: a new message with these labels, recorded in history. Returns its id. */
  deliver(email: string, raw: string | Uint8Array, labelIds: string[] = ["INBOX", "UNREAD"]): string {
    const mailbox = this.mailbox(email);
    const id = (this.nextId++).toString(16).padStart(16, "0");
    const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
    mailbox.messages.set(id, { id, threadId: id, labelIds: [...labelIds], raw: bytes, internalDate: this.now() });
    mailbox.historyId += 1;
    mailbox.history.push({ id: mailbox.historyId, messagesAdded: [{ message: { id, labelIds: [...labelIds] } }] });
    return id;
  }

  /** Someone (or a Gmail filter) applies a label to an existing message. */
  addLabel(email: string, id: string, labelId: string): void {
    const mailbox = this.mailbox(email);
    const message = mailbox.messages.get(id);
    if (!message) throw new Error(`no message ${id}`);
    message.labelIds.push(labelId);
    mailbox.historyId += 1;
    mailbox.history.push({
      id: mailbox.historyId,
      labelsAdded: [{ message: { id, labelIds: [...message.labelIds] }, labelIds: [labelId] }],
    });
  }

  deleteMessage(email: string, id: string): void {
    this.mailbox(email).messages.delete(id);
  }

  /** Gmail drops history older than now (a mailbox not synced for a long while). */
  expireHistory(email: string): void {
    const mailbox = this.mailbox(email);
    mailbox.oldestHistoryId = mailbox.historyId + 1;
  }

  /** The user revokes the app's access (myaccount.google.com), or a Testing-mode token expires. */
  revokeGrants(email: string): void {
    for (const [t, grant] of this.refreshTokens) if (grant.email === email.toLowerCase()) this.refreshTokens.delete(t);
    for (const [t, grant] of this.accessTokens) if (grant.email === email.toLowerCase()) this.accessTokens.delete(t);
  }

  /**
   * The consent screen: given the authorization URL the app redirected to, returns the URL Google
   * sends the browser back to (with a code, or `error=access_denied`).
   */
  consent(authorizationUrl: string, consent: Consent = this.nextConsent): string {
    const url = new URL(authorizationUrl);
    const q = url.searchParams;
    if (q.get("client_id") !== this.client.clientId) throw new Error("fake Google: unknown client_id");
    const redirectUri = q.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    back.searchParams.set("state", q.get("state") ?? "");
    if (consent.deny) {
      back.searchParams.set("error", "access_denied");
      return back.href;
    }
    const first = this.mailboxes.keys().next().value;
    const email = (consent.email ?? q.get("login_hint") ?? first ?? "").toLowerCase();
    this.mailbox(email);
    const requested = (q.get("scope") ?? "").split(" ").filter(Boolean);
    const code = token("4/fake-code-");
    this.codes.set(code, {
      email,
      scopes: consent.scopes ?? requested,
      challenge: q.get("code_challenge") ?? "",
      redirectUri,
      offline: q.get("access_type") === "offline",
    });
    back.searchParams.set("code", code);
    back.searchParams.set("scope", (consent.scopes ?? requested).join(" "));
    return back.href;
  }

  /** A drop-in `fetch` for GoogleDeps. */
  readonly fetch: typeof fetch = async (input, init) => this.handle(new Request(input, init));

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    this.calls.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/o/oauth2/v2/auth" && req.method === "GET") {
      return new Response(null, { status: 302, headers: { location: this.consent(url.href) } });
    }
    if (url.pathname === "/token" && req.method === "POST") return this.tokenEndpoint(await req.formData());
    if (url.pathname === "/revoke" && req.method === "POST") {
      const t = String((await req.formData()).get("token") ?? "");
      const known = this.refreshTokens.delete(t) || this.accessTokens.delete(t);
      if (!known) return googleError(400, "invalid_token");
      this.revoked.push(t);
      return new Response(null, { status: 200 });
    }
    const gmail = url.pathname.match(/^\/gmail\/v1\/users\/me\/(.+)$/);
    if (gmail?.[1]) return this.gmail(req, gmail[1], url.searchParams);
    return googleError(404, "not_found");
  }

  private tokenEndpoint(form: FormData): Response {
    if (form.get("client_id") !== this.client.clientId || form.get("client_secret") !== this.client.clientSecret) {
      return googleError(401, "invalid_client");
    }
    const issue = (grant: Grant, refreshToken: string | null, idToken: boolean) => {
      const accessToken = token("ya29.fake-");
      this.accessTokens.set(accessToken, { ...grant, expiresAt: this.now() + 3599_000 });
      const mailbox = this.mailbox(grant.email);
      return json({
        access_token: accessToken,
        expires_in: 3599,
        token_type: "Bearer",
        scope: grant.scopes.join(" "),
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
        ...(idToken ? { id_token: this.idToken(mailbox) } : {}),
      });
    };
    if (form.get("grant_type") === "authorization_code") {
      const code = String(form.get("code") ?? "");
      const pending = this.codes.get(code);
      this.codes.delete(code);
      if (!pending || pending.redirectUri !== form.get("redirect_uri")) return googleError(400, "invalid_grant");
      const verifier = String(form.get("code_verifier") ?? "");
      if (createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
        return googleError(400, "invalid_grant");
      }
      const grant = { email: pending.email, scopes: pending.scopes };
      const refreshToken = pending.offline ? token("1//fake-refresh-") : null;
      if (refreshToken) this.refreshTokens.set(refreshToken, grant);
      return issue(grant, refreshToken, true);
    }
    if (form.get("grant_type") === "refresh_token") {
      const grant = this.refreshTokens.get(String(form.get("refresh_token") ?? ""));
      if (!grant) return googleError(400, "invalid_grant");
      return issue(grant, null, false);
    }
    return googleError(400, "unsupported_grant_type");
  }

  private idToken(mailbox: FakeMailbox): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const iat = Math.floor(this.now() / 1000);
    const claims = {
      iss: "https://accounts.google.com",
      aud: this.client.clientId,
      sub: mailbox.sub,
      email: mailbox.email,
      email_verified: true,
      ...(mailbox.hd ? { hd: mailbox.hd } : {}),
      iat,
      exp: iat + 3600,
    };
    return `${part({ alg: "RS256", kid: "fake" })}.${part(claims)}.fake-signature`;
  }

  private gmail(req: Request, path: string, q: URLSearchParams): Response {
    const bearer = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const grant = this.accessTokens.get(bearer);
    if (!grant || grant.expiresAt <= this.now()) return googleError(401, "invalid_credentials");
    if (!grant.scopes.includes(GMAIL_READONLY_SCOPE)) return googleError(403, "insufficientPermissions");
    const mailbox = this.mailbox(grant.email);

    if (path === "profile") {
      return json({
        emailAddress: mailbox.email,
        historyId: String(mailbox.historyId),
        messagesTotal: mailbox.messages.size,
      });
    }
    if (path === "labels") return json({ labels: mailbox.labels });
    if (path === "history") {
      const start = Number(q.get("startHistoryId"));
      if (!Number.isFinite(start) || start < mailbox.oldestHistoryId) return googleError(404, "notFound");
      const label = q.get("labelId");
      const after = Number(q.get("pageToken") ?? start);
      const max = Number(q.get("maxResults") ?? 100);
      const matching = mailbox.history.filter(
        (r) =>
          r.id > after &&
          (!label ||
            r.messagesAdded?.some((m) => m.message.labelIds.includes(label)) ||
            r.labelsAdded?.some((l) => l.labelIds.includes(label))),
      );
      const page = matching.slice(0, max);
      const more = matching.length > max;
      return json({
        history: page.map((r) => ({
          ...r,
          id: String(r.id),
          messagesAdded: r.messagesAdded?.filter((m) => !label || m.message.labelIds.includes(label)),
        })),
        historyId: String(mailbox.historyId),
        ...(more ? { nextPageToken: String(page.at(-1)?.id) } : {}),
      });
    }
    if (path === "messages") {
      const label = q.get("labelIds");
      const newer = q.get("q")?.match(/newer_than:(\d+)d/);
      const afterSeconds = q.get("q")?.match(/after:(\d+)/);
      const since = newer
        ? this.now() - Number(newer[1]) * 86_400_000
        : afterSeconds
          ? Number(afterSeconds[1]) * 1000
          : 0;
      const ids = [...mailbox.messages.values()]
        .filter((m) => (!label || m.labelIds.includes(label)) && m.internalDate >= since)
        .sort((a, b) => b.internalDate - a.internalDate)
        .map((m) => ({ id: m.id, threadId: m.threadId }));
      const offset = Number(q.get("pageToken") ?? 0);
      const max = Number(q.get("maxResults") ?? 100);
      const page = ids.slice(offset, offset + max);
      return json({ messages: page, ...(offset + max < ids.length ? { nextPageToken: String(offset + max) } : {}) });
    }
    const message = path.match(/^messages\/([^/?]+)$/);
    if (message?.[1]) {
      const found = mailbox.messages.get(decodeURIComponent(message[1]));
      if (!found) return googleError(404, "notFound");
      const meta = {
        id: found.id,
        threadId: found.threadId,
        labelIds: found.labelIds,
        sizeEstimate: found.raw.byteLength,
        internalDate: String(found.internalDate),
        historyId: String(mailbox.historyId),
      };
      if (q.get("format") === "raw") return json({ ...meta, raw: Buffer.from(found.raw).toString("base64url") });
      return json(meta);
    }
    return googleError(404, "notFound");
  }
}
