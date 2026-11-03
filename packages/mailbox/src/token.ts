import { MailboxAuthError } from "./errors";
import type { GoogleDeps } from "./google/http";
import { refreshAccessToken } from "./google/oauth";

// Access tokens live an hour and are kept (encrypted) with the connection, so jobs reuse one
// instead of refreshing every time. The store is the caller's: short transactions on the
// connection row, never held across a call to Google.

export interface StoredTokens {
  refreshToken: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
}

export interface TokenStore {
  read(): Promise<StoredTokens | null>;
  save(accessToken: string, expiresAt: Date): Promise<void>;
  /** The grant is dead (invalid_grant): mark the connection for reconnecting. */
  revoked(): Promise<void>;
}

/** A token this close to expiry is refreshed first. */
const EARLY_SECONDS = 120;

/**
 * Runs `fn` with a working access token: the stored one while it's fresh, else a refreshed one. If
 * the API still refuses it (revoked since), refreshes once and retries. A refresh that Google
 * refuses marks the connection revoked and throws MailboxAuthError. Null tokens (disconnected)
 * throw MailboxAuthError too.
 */
export async function withAccessToken<T>(
  deps: GoogleDeps,
  store: TokenStore,
  fn: (accessToken: string) => Promise<T>,
  now: () => Date = () => new Date(),
): Promise<T> {
  const tokens = await store.read();
  if (!tokens) throw new MailboxAuthError("The mailbox is disconnected");
  const refresh = async () => {
    try {
      const fresh = await refreshAccessToken(deps, tokens.refreshToken, now());
      await store.save(fresh.accessToken, fresh.expiresAt);
      return fresh.accessToken;
    } catch (err) {
      if (err instanceof MailboxAuthError) await store.revoked();
      throw err;
    }
  };
  const fresh =
    tokens.accessToken &&
    tokens.accessTokenExpiresAt &&
    tokens.accessTokenExpiresAt.getTime() - now().getTime() > EARLY_SECONDS * 1000;
  const first = fresh && tokens.accessToken ? tokens.accessToken : await refresh();
  try {
    return await fn(first);
  } catch (err) {
    if (!(err instanceof MailboxAuthError) || !fresh) throw err;
    return fn(await refresh());
  }
}
