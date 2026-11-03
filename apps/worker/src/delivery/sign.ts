import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TOLERANCE_SECONDS } from "@ai-triage/core";

// X-Triage-Signature: `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`. Signing the
// timestamp with the body lets a receiver reject old replays; the Idempotency-Key header (the action
// id) is what it dedupes on, since a redelivery is signed afresh.

const mac = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();

export function signWebhook(secret: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return `t=${t},v1=${mac(secret, t, body).toString("hex")}`;
}

/** What a receiver does (see the README's receiver contract). Used by tests and the local catcher. */
export function verifyWebhook(
  secret: string,
  header: string | null,
  body: string,
  now: Date,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  const given = Buffer.from(parts.v1, "hex");
  const expected = mac(secret, t, body);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
