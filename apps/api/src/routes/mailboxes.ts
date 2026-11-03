import {
  AuthorizeMailboxRequest,
  type AuthorizeResponse,
  type ErrorResponse,
  type MailboxDetail,
  type MailboxLabels,
  type MailboxList,
  type MailboxSummary,
  UpdateMailboxRequest,
} from "@ai-triage/contracts";
import { isOneOf, MAILBOX_MESSAGE_REASONS, MAILBOX_MESSAGE_STATUSES } from "@ai-triage/core";
import {
  type AuditActor,
  type ConnectionSummary,
  connectMailbox,
  consumeOAuthState,
  createOAuthState,
  disconnectMailbox,
  getMailbox,
  getMembership,
  listMailboxes,
  MemberError,
  mailboxTokenStore,
  mailboxTokens,
  recentMailboxMessages,
  recordAudit,
  setWorkspaceDomain,
  updateMailbox,
  withTenantTx,
} from "@ai-triage/db";
import {
  authorizationUrl,
  exchangeCode,
  GMAIL_READONLY_SCOPE,
  type GoogleDeps,
  getProfile,
  idTokenClaims,
  listLabels,
  MAILBOX_SCOPES,
  MailboxAuthError,
  pkcePair,
  revokeToken,
  withAccessToken,
} from "@ai-triage/mailbox";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { userActor } from "../audit";
import { clientIp } from "../client-ip";
import type { AppDeps } from "../deps";
import { limitUserWrites } from "../rate-limit";
import { requireRole, requireTenant, type TenantEnv } from "../tenant";
import { validate } from "../validate";
import { idParam } from "./documents";

/** Where Google sends the browser back to, for mailbox connections and the Workspace domain check. */
export const GOOGLE_CALLBACK_PATH = "/integrations/google/callback";
export const googleRedirectUri = (deps: Pick<AppDeps, "apiBaseUrl">) => `${deps.apiBaseUrl}${GOOGLE_CALLBACK_PATH}`;

export function googleDeps(deps: AppDeps): GoogleDeps {
  if (!deps.google) throw new Error("Google isn't configured");
  return { config: deps.google, fetch: deps.googleFetch };
}

const iso = (d: Date | null) => d?.toISOString() ?? null;
const toSummary = (m: ConnectionSummary): MailboxSummary => ({
  ...m,
  lastSyncedAt: iso(m.lastSyncedAt),
  lastErrorAt: iso(m.lastErrorAt),
  createdAt: m.createdAt.toISOString(),
});

const googleOff = (c: Context) => {
  const body: ErrorResponse = { error: "Google isn't set up on this instance (GOOGLE_CLIENT_ID)." };
  return c.json(body, 404);
};

const reconnect = (c: Context) => {
  const body: ErrorResponse = { error: "The mailbox's access was revoked or expired: reconnect it." };
  return c.json(body, 409);
};

/**
 * Connected mailboxes (admins only). Connecting is an OAuth round trip: `authorize` returns the
 * Google URL, and Google sends the browser to GOOGLE_CALLBACK_PATH (integrationRoutes below).
 */
export const mailboxRoutes = (deps: AppDeps) =>
  new Hono<TenantEnv>()
    .use(requireTenant(deps), requireRole("admin"), limitUserWrites(deps, deps.rateLimits.writesPerUser))
    .get("/", async (c) => {
      const mailboxes = await withTenantTx(deps.pool, c.var.tenant.tenantId, listMailboxes);
      const body: MailboxList = { mailboxes: mailboxes.map(toSummary), google: deps.google !== null };
      return c.json(body, 200);
    })
    .post("/google/authorize", validate("json", AuthorizeMailboxRequest), async (c) => {
      if (!deps.google) return googleOff(c);
      const { backfillDays, loginHint } = c.req.valid("json");
      const { verifier, challenge } = pkcePair();
      const state = await withTenantTx(deps.pool, c.var.tenant.tenantId, (tx) =>
        createOAuthState(tx, {
          userId: c.var.tenant.user.id,
          purpose: "mailbox",
          codeVerifier: verifier,
          backfillDays,
          now: deps.now(),
        }),
      );
      const url = authorizationUrl(googleDeps(deps), {
        state,
        codeChallenge: challenge,
        redirectUri: googleRedirectUri(deps),
        scopes: MAILBOX_SCOPES,
        offline: true,
        loginHint,
      });
      const body: AuthorizeResponse = { url };
      return c.json(body, 200);
    })
    .get("/:id", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const body = await withTenantTx(deps.pool, c.var.tenant.tenantId, async (tx): Promise<MailboxDetail | null> => {
        const mailbox = await getMailbox(tx, id);
        if (!mailbox) return null;
        const messages = await recentMailboxMessages(tx, id);
        return {
          mailbox: toSummary(mailbox),
          messages: messages.map((m) => ({
            ...m,
            status: isOneOf(MAILBOX_MESSAGE_STATUSES, m.status) ? m.status : "queued",
            reason: isOneOf(MAILBOX_MESSAGE_REASONS, m.reason) ? m.reason : null,
            receivedAt: iso(m.receivedAt),
            createdAt: m.createdAt.toISOString(),
          })),
        };
      });
      return body ? c.json(body, 200) : c.json({ error: "Not found" }, 404);
    })
    .get("/:id/labels", idParam, async (c) => {
      if (!deps.google) return googleOff(c);
      const { id } = c.req.valid("param");
      const { tenantId } = c.var.tenant;
      try {
        const store = mailboxTokenStore(deps.pool, deps.keys, tenantId, id, deps.now);
        const labels = await withAccessToken(
          googleDeps(deps),
          store,
          (token) => listLabels(googleDeps(deps), token),
          deps.now,
        );
        // Spam, trash, drafts and the like never make sense as an intake label.
        const usable = labels.filter((l) => l.type !== "system" || ["INBOX", "IMPORTANT", "STARRED"].includes(l.id));
        const body: MailboxLabels = { labels: usable };
        return c.json(body, 200);
      } catch (err) {
        if (err instanceof MailboxAuthError) return reconnect(c);
        throw err;
      }
    })
    .patch("/:id", idParam, validate("json", UpdateMailboxRequest), async (c) => {
      const { id } = c.req.valid("param");
      const { labelId, paused } = c.req.valid("json");
      const { tenantId } = c.var.tenant;
      let labelName: string | undefined;
      if (labelId) {
        if (!deps.google) return googleOff(c);
        try {
          const store = mailboxTokenStore(deps.pool, deps.keys, tenantId, id, deps.now);
          const labels = await withAccessToken(
            googleDeps(deps),
            store,
            (t) => listLabels(googleDeps(deps), t),
            deps.now,
          );
          labelName = labels.find((l) => l.id === labelId)?.name;
        } catch (err) {
          if (err instanceof MailboxAuthError) return reconnect(c);
          throw err;
        }
        if (!labelName) {
          const body: ErrorResponse = {
            error: "That label isn't in the mailbox.",
            issues: [{ field: "labelId", path: "/labelId", message: "unknown label" }],
          };
          return c.json(body, 422);
        }
      }
      const updated = await withTenantTx(deps.pool, tenantId, async (tx) => {
        const mailbox = await updateMailbox(tx, id, { labelId, labelName, paused }, deps.now());
        if (mailbox) {
          await recordAudit(tx, userActor(c, deps), {
            action: "mailbox.updated",
            target: { type: "mailbox", id },
            details: {
              email: mailbox.email,
              ...(labelId ? { labelId, labelName } : {}),
              ...(paused === undefined ? {} : { paused }),
            },
          });
        }
        return mailbox;
      });
      return updated ? c.json(toSummary(updated), 200) : c.json({ error: "Not found" }, 404);
    })
    .delete("/:id", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const { tenantId } = c.var.tenant;
      // Revoke at Google first (no transaction open), then forget the tokens here either way.
      const tokens = await withTenantTx(deps.pool, tenantId, (tx) => mailboxTokens(tx, deps.keys, id));
      let revoked = false;
      if (tokens && deps.google) {
        try {
          await revokeToken(googleDeps(deps), tokens.refreshToken);
          revoked = true;
        } catch (err) {
          console.warn(`req=${c.get("requestId")} could not revoke a mailbox token at Google: ${(err as Error).name}`);
        }
      }
      const found = await withTenantTx(deps.pool, tenantId, async (tx) => {
        const mailbox = await getMailbox(tx, id);
        if (!mailbox || mailbox.status === "disconnected") return false;
        await disconnectMailbox(tx, id);
        await recordAudit(tx, userActor(c, deps), {
          action: "mailbox.disconnected",
          target: { type: "mailbox", id },
          details: { email: mailbox.email, revokedAtProvider: revoked },
        });
        return true;
      });
      return found ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
    });

/** The Workspace domain branch of the callback: the domain is the `hd` of the account the admin used. */
async function verifyWorkspaceDomain(
  c: Context,
  deps: AppDeps,
  input: {
    tenantId: string;
    pending: { codeVerifier: string; joinRole: string | null };
    code: string | undefined;
    error: string | undefined;
    session: { user: { id: string; email: string } };
  },
) {
  const back = (params: Record<string, string>) =>
    c.redirect(`${deps.webOrigin}/settings/members?${new URLSearchParams(params)}`, 302);
  if (input.error) return back({ error: input.error === "access_denied" ? "access_denied" : "google_error" });
  if (!input.code) return back({ error: "google_error" });
  try {
    const tokens = await exchangeCode(
      googleDeps(deps),
      { code: input.code, codeVerifier: input.pending.codeVerifier, redirectUri: googleRedirectUri(deps) },
      deps.now(),
    );
    const claims = tokens.idToken ? idTokenClaims(tokens.idToken) : null;
    // `hd` is present only for Google Workspace accounts: a consumer account proves no domain.
    if (!claims?.hd || claims.email_verified !== true) return back({ error: "not_workspace_account" });
    const domain = claims.hd.toLowerCase();
    await withTenantTx(deps.pool, input.tenantId, (tx) =>
      setWorkspaceDomain(
        tx,
        {
          type: "user",
          id: input.session.user.id,
          label: input.session.user.email,
          ip: clientIp(c, deps.trustedProxies),
          userAgent: c.req.header("user-agent") ?? null,
          requestId: c.get("requestId"),
        },
        { domain, joinRole: input.pending.joinRole === "reviewer" ? "reviewer" : "viewer" },
      ),
    );
    return back({ domain });
  } catch (err) {
    if (err instanceof MemberError) return back({ error: err.code });
    console.warn(`req=${c.get("requestId")} domain check failed: ${(err as Error).name}: ${(err as Error).message}`);
    return back({ error: "google_error" });
  }
}

/** Why a Google round trip didn't end in a connection, as `?error=` on the web page it returns to. */
export type CallbackError =
  | "google_off"
  | "state_invalid"
  | "forbidden"
  | "access_denied"
  | "scope_missing"
  | "no_refresh_token"
  | "google_error";

/**
 * Google's redirect back after consent. A GET from the browser, so it carries the session cookie
 * (SameSite=Lax) and no Origin check applies; the `state` is what ties it to the admin who started
 * it (single use, same user, ten minutes). The authorization code never reaches a log: the request
 * log records the path only.
 */
export const integrationRoutes = (deps: AppDeps) =>
  new Hono().get(GOOGLE_CALLBACK_PATH.replace("/integrations", ""), async (c) => {
    const back = (params: Record<string, string>) =>
      c.redirect(`${deps.webOrigin}/settings/mailboxes?${new URLSearchParams(params)}`, 302);
    const fail = (error: CallbackError) => back({ error });
    if (!deps.google) return fail("google_off");

    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.redirect(`${deps.webOrigin}/sign-in`, 302);
    const tenantId = session.session.activeOrganizationId;
    const membership = tenantId ? await getMembership(deps.db, session.user.id, tenantId) : null;
    const twoFactorMissing = deps.requireAdmin2fa && session.user.twoFactorEnabled !== true;
    if (!tenantId || membership?.role !== "admin" || twoFactorMissing) return fail("forbidden");

    const query = z
      .object({ state: z.uuid(), code: z.string().min(1).max(2000).optional(), error: z.string().max(200).optional() })
      .safeParse(c.req.query());
    if (!query.success) return fail("state_invalid");
    const { state, code, error } = query.data;
    const pending = await withTenantTx(deps.pool, tenantId, (tx) =>
      consumeOAuthState(tx, { state, userId: session.user.id, now: deps.now() }),
    );
    if (!pending) return fail("state_invalid");
    if (pending.purpose === "workspace_domain") {
      return verifyWorkspaceDomain(c, deps, { tenantId, pending, code, error, session });
    }
    if (error) return fail(error === "access_denied" ? "access_denied" : "google_error");
    if (!code) return fail("google_error");

    const actor: AuditActor = {
      type: "user",
      id: session.user.id,
      label: session.user.email,
      ip: clientIp(c, deps.trustedProxies),
      userAgent: c.req.header("user-agent") ?? null,
      requestId: c.get("requestId"),
    };
    const google = googleDeps(deps);
    try {
      const tokens = await exchangeCode(
        google,
        { code, codeVerifier: pending.codeVerifier, redirectUri: googleRedirectUri(deps) },
        deps.now(),
      );
      // Google's granular consent lets the user untick Gmail access: without it there's nothing to sync.
      if (!tokens.scopes.includes(GMAIL_READONLY_SCOPE)) {
        await revokeToken(google, tokens.refreshToken ?? tokens.accessToken).catch(() => {});
        return fail("scope_missing");
      }
      if (!tokens.refreshToken) return fail("no_refresh_token");
      const profile = await getProfile(google, tokens.accessToken);
      const sub = tokens.idToken ? idTokenClaims(tokens.idToken).sub : null;
      const result = await withTenantTx(deps.pool, tenantId, async (tx) => {
        const connected = await connectMailbox(tx, deps.keys, {
          provider: "google",
          email: profile.emailAddress,
          providerAccountId: sub,
          refreshToken: tokens.refreshToken ?? "",
          accessToken: tokens.accessToken,
          accessTokenExpiresAt: tokens.expiresAt,
          scopes: tokens.scopes,
          historyId: profile.historyId,
          backfillDays: pending.backfillDays ? pending.backfillDays : null,
          connectedBy: session.user.id,
          now: deps.now(),
        });
        await recordAudit(tx, actor, {
          action: "mailbox.connected",
          target: { type: "mailbox", id: connected.id },
          details: {
            provider: "google",
            email: profile.emailAddress.toLowerCase(),
            reconnected: connected.reconnected,
            backfillDays: pending.backfillDays ?? 0,
          },
        });
        return connected;
      });
      return back({ connected: result.id });
    } catch (err) {
      // The provider's response stays out of the redirect and the audit log.
      console.warn(
        `req=${c.get("requestId")} mailbox connection failed: ${(err as Error).name}: ${(err as Error).message}`,
      );
      return fail("google_error");
    }
  });
