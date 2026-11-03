import type { GoogleConfig } from "../config";
import { MailboxApiError, MailboxRateLimitError } from "../errors";

/** What every Google call needs: the client, a fetch (tests and the demo pass a fake) and a timeout. */
export interface GoogleDeps {
  config: GoogleConfig;
  fetch: typeof fetch;
  /** Per request; Gmail downloads of large messages get the same budget. Default 30 s. */
  timeoutMs?: number;
}

/** At most this much of an error body is read (into the message, for the log). */
const MAX_ERROR_BYTES = 2048;

async function errorText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, MAX_ERROR_BYTES);
  } catch {
    return "";
  }
}

const retryAfter = (res: Response) => {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 60;
};

/**
 * Sends a request and returns the response if it's a 2xx. A 429, or a 403 whose reason is a rate
 * limit, becomes MailboxRateLimitError; `onError` may map other statuses first (it returns an error
 * to throw, or undefined); everything else is MailboxApiError.
 */
export async function send(
  deps: GoogleDeps,
  url: string,
  init: RequestInit,
  onError?: (status: number, body: string) => Error | undefined,
): Promise<Response> {
  const res = await deps.fetch(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
  });
  if (res.ok) return res;
  const body = await errorText(res);
  if (res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body))) {
    throw new MailboxRateLimitError(retryAfter(res), `Google rate limit (${res.status})`);
  }
  const mapped = onError?.(res.status, body);
  if (mapped) throw mapped;
  throw new MailboxApiError(res.status, `Google API ${res.status}: ${body.slice(0, 300)}`);
}
