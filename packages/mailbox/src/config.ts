// Google settings from the environment. One OAuth client serves both Sign in with Google (Better
// Auth) and mailbox connections (this package), so both read it from here. Unset: every Google
// feature is hidden, and the demo needs no Google project (docs/google.md).

/** Google's endpoints. Tests and the local demo point them at the fake in ./testing (`pnpm fake-google`). */
export const GOOGLE_ENDPOINTS = {
  oauth: "https://accounts.google.com",
  token: "https://oauth2.googleapis.com",
  api: "https://gmail.googleapis.com",
} as const;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** Where the consent screen lives (`/o/oauth2/v2/auth`). */
  oauthUrl: string;
  /** Token, refresh and revoke (`/token`, `/revoke`). */
  tokenUrl: string;
  /** The Gmail REST API (`/gmail/v1/...`). */
  apiUrl: string;
}

type Env = Record<string, string | undefined>;

export class GoogleConfigError extends Error {
  override name = "GoogleConfigError";
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

/**
 * The Google client, or null when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both unset. One
 * without the other is a mistake, not "off". GOOGLE_OAUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_API_URL
 * point the Google endpoints at a fake (tests, the demo's `pnpm fake-google`); startup refuses them in production
 * unless TRIAGE_DEMO=true (packages/db/src/startup.ts).
 */
export function googleConfigFromEnv(env: Env): GoogleConfig | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new GoogleConfigError("Set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither");
  }
  const oauthOverride = env.GOOGLE_OAUTH_URL?.trim();
  // The browser opens the consent screen; the server calls the token endpoint. In docker compose
  // they reach the fake at different addresses (localhost vs the service name).
  const tokenOverride = env.GOOGLE_TOKEN_URL?.trim() || oauthOverride;
  const apiOverride = env.GOOGLE_API_URL?.trim();
  return {
    clientId,
    clientSecret,
    oauthUrl: trimSlash(oauthOverride || GOOGLE_ENDPOINTS.oauth),
    tokenUrl: trimSlash(tokenOverride || GOOGLE_ENDPOINTS.token),
    apiUrl: trimSlash(apiOverride || GOOGLE_ENDPOINTS.api),
  };
}

/**
 * Whether Sign in with Google can work: Better Auth always talks to the real Google, so against a
 * fake (the demo) only mailbox connections do.
 */
export const isRealGoogle = (config: GoogleConfig) =>
  config.oauthUrl === GOOGLE_ENDPOINTS.oauth && config.tokenUrl === GOOGLE_ENDPOINTS.token;
