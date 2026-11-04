import { WEBHOOK_HEADERS } from "@ai-triage/core";
import { isEgressBlocked } from "./egress";
import { signWebhook } from "./sign";

// One signed webhook POST (docs/architecture.md §5, delivery), shared by `action.deliver` and the
// Settings test event: the receiver contract's headers, no redirects, a timeout, and at most 4 KiB of
// the response read. The caller decides what the outcome means (retry, fail, show it).

export type WebhookOutcome = { ok: true; status: number } | { ok: false; permanent: boolean; error: string };

/** The receiver said no in a way retrying won't change. 408, 425 and 429 mean "try again later". */
export const isPermanent = (status: number) =>
  (status >= 300 && status < 400) || (status >= 400 && status < 500 && ![408, 425, 429].includes(status));

/** How much of a receiver's error response is read (and the start of it kept in last_error). */
const MAX_RESPONSE_BYTES = 4096;

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES).toString("utf8");
}

export async function postWebhook(input: {
  /** The guarded fetch (createGuardedFetch); tests pass their own. */
  fetch: typeof fetch;
  url: string;
  secrets: readonly string[];
  idempotencyKey: string;
  event: string;
  body: string;
  now: Date;
  timeoutMs: number;
}): Promise<WebhookOutcome> {
  try {
    const res = await input.fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ai-triage-webhooks/1",
        [WEBHOOK_HEADERS.idempotencyKey]: input.idempotencyKey,
        [WEBHOOK_HEADERS.event]: input.event,
        [WEBHOOK_HEADERS.signature]: signWebhook(input.secrets, input.idempotencyKey, input.body, input.now),
      },
      body: input.body,
      // A redirect is a misconfigured URL: don't follow it, and don't send the payload somewhere else.
      redirect: "manual",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    const text = (await readCapped(res).catch(() => "")).slice(0, 300);
    return { ok: false, permanent: isPermanent(res.status), error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
  } catch (err) {
    // The URL (or what it resolves to) isn't allowed: retrying won't change that.
    if (isEgressBlocked(err)) {
      return {
        ok: false,
        permanent: true,
        error: "webhook URL not allowed: it must be public https (see docs/security.md)",
      };
    }
    // Members can read this, so it stays generic: no addresses or socket details.
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      permanent: false,
      error: timedOut ? `timed out after ${input.timeoutMs} ms` : "connection failed",
    };
  }
}
