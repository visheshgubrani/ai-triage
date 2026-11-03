// What can go wrong talking to a mail provider, sorted by what the caller should do about it.

/**
 * The mailbox's grant no longer works: the refresh token was revoked or expired (`invalid_grant`),
 * or the API refuses a freshly refreshed access token. Polling stops until an admin reconnects.
 */
export class MailboxAuthError extends Error {
  override name = "MailboxAuthError";
}

/** The sync cursor is older than the history the provider keeps (Gmail: a 404 from history.list). */
export class HistoryExpiredError extends Error {
  override name = "HistoryExpiredError";
}

/** The message no longer exists (deleted between the sync and the download). */
export class MessageGoneError extends Error {
  override name = "MessageGoneError";
}

/** The provider asked to slow down. Retry after `retryAfterSeconds`. */
export class MailboxRateLimitError extends Error {
  override name = "MailboxRateLimitError";
  constructor(
    readonly retryAfterSeconds: number,
    message = "rate limited",
  ) {
    super(message);
  }
}

/** Any other refusal or outage. 5xx and network errors are worth retrying; the caller decides. */
export class MailboxApiError extends Error {
  override name = "MailboxApiError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
