import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { MailboxApiError, MailboxAuthError } from "../errors";
import { type GoogleDeps, send } from "./http";

// Google's OAuth 2.0 web-server flow, for mailbox connections and the Workspace domain check
// (Sign in with Google goes through Better Auth instead). Authorization code with PKCE (S256), the
// client secret on the token request, and an offline grant so the worker can refresh.

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const MAILBOX_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE] as const;
export const IDENTITY_SCOPES = ["openid", "email"] as const;

/** The PKCE pair: the verifier stays on the server, the challenge goes to Google. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: readonly string[];
  /** Ask for a refresh token (mailboxes). Forces the consent screen, so Google issues one. */
  offline: boolean;
  /** Pre-fills the account picker (reconnecting a known mailbox). */
  loginHint?: string;
  /** `*`: only Google Workspace accounts (the domain check). */
  hostedDomain?: string;
}

export function authorizationUrl(deps: Pick<GoogleDeps, "config">, req: AuthorizationRequest): string {
  const params = new URLSearchParams({
    client_id: deps.config.clientId,
    redirect_uri: req.redirectUri,
    response_type: "code",
    scope: req.scopes.join(" "),
    state: req.state,
    code_challenge: req.codeChallenge,
    code_challenge_method: "S256",
    // Each flow asks for exactly its own scopes, never earlier grants of the same client.
    include_granted_scopes: "false",
    prompt: req.offline ? "consent" : "select_account",
    access_type: req.offline ? "offline" : "online",
  });
  if (req.loginHint) params.set("login_hint", req.loginHint);
  if (req.hostedDomain) params.set("hd", req.hostedDomain);
  return `${deps.config.oauthUrl}/o/oauth2/v2/auth?${params}`;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export interface GoogleTokens {
  accessToken: string;
  expiresAt: Date;
  /** Only on the first exchange of an offline grant. */
  refreshToken: string | null;
  /** What the user actually granted: granular consent lets them untick a scope. */
  scopes: string[];
  idToken: string | null;
}

/** A failed token request: `invalid_grant` means the refresh token (or code) is dead. */
const tokenError = (status: number, body: string) =>
  status === 400 && /"invalid_grant"/.test(body)
    ? new MailboxAuthError("Google refused the grant (invalid_grant)")
    : undefined;

async function tokenRequest(deps: GoogleDeps, form: Record<string, string>, now: Date): Promise<GoogleTokens> {
  const res = await send(
    deps,
    `${deps.config.tokenUrl}/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: deps.config.clientId, client_secret: deps.config.clientSecret, ...form }),
    },
    tokenError,
  );
  const parsed = TokenResponse.safeParse(await res.json());
  if (!parsed.success) throw new MailboxApiError(502, "Unexpected token response from Google");
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    expiresAt: new Date(now.getTime() + t.expires_in * 1000),
    refreshToken: t.refresh_token ?? null,
    scopes: t.scope?.split(" ").filter(Boolean) ?? [],
    idToken: t.id_token ?? null,
  };
}

export function exchangeCode(
  deps: GoogleDeps,
  input: { code: string; codeVerifier: string; redirectUri: string },
  now = new Date(),
): Promise<GoogleTokens> {
  return tokenRequest(
    deps,
    {
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    },
    now,
  );
}

export function refreshAccessToken(deps: GoogleDeps, refreshToken: string, now = new Date()): Promise<GoogleTokens> {
  return tokenRequest(deps, { grant_type: "refresh_token", refresh_token: refreshToken }, now);
}

/** Revokes a refresh (or access) token at Google. A token Google already forgot counts as revoked. */
export async function revokeToken(deps: GoogleDeps, token: string): Promise<void> {
  await send(
    deps,
    `${deps.config.tokenUrl}/revoke`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    },
    (status) => (status === 400 ? new RevokedAlready() : undefined),
  ).catch((err) => {
    if (!(err instanceof RevokedAlready)) throw err;
  });
}

class RevokedAlready extends Error {}

const IdTokenClaims = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
});
export type IdTokenClaims = z.infer<typeof IdTokenClaims>;

/**
 * The claims of an ID token that came straight from Google's token endpoint over TLS. OpenID
 * Connect lets a code-flow client trust such a token without checking its signature (Core §3.1.3.7),
 * so it's only decoded. Never use this on an ID token from the browser.
 */
export function idTokenClaims(idToken: string): IdTokenClaims {
  const payload = idToken.split(".")[1];
  if (!payload) throw new MailboxApiError(502, "Malformed ID token from Google");
  const parsed = IdTokenClaims.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  if (!parsed.success) throw new MailboxApiError(502, "Unexpected ID token claims from Google");
  return parsed.data;
}
