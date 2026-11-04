import { createHmac, timingSafeEqual } from "node:crypto";
import { WEBHOOK_TOLERANCE_SECONDS } from "@ai-triage/core";

// X-Triage-Signature: `t=<unix seconds>,v2=<hex HMAC-SHA256(secret, "<t>.<idempotency key>.<body>")>`.
// Signing the timestamp lets a receiver reject old replays; signing the Idempotency-Key (the action
// id, which receivers dedupe on) means a captured delivery can't be replayed under a fresh key.
// During a secret rotation's grace period there is one v2 per secret, newest first; a receiver
// accepts the delivery if any of them verifies with the secret it holds.

const mac = (secret: string, timestamp: number, idempotencyKey: string, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${idempotencyKey}.${body}`).digest();

export function signWebhook(secrets: readonly string[], idempotencyKey: string, body: string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  return [`t=${t}`, ...secrets.map((s) => `v2=${mac(s, t, idempotencyKey, body).toString("hex")}`)].join(",");
}

/** What a receiver does (see the README's receiver contract). Used by tests; the catcher mirrors it. */
export function verifyWebhook(
  secret: string,
  header: string | null,
  idempotencyKey: string | null,
  body: string,
  now: Date,
  toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS,
): boolean {
  if (!header || !idempotencyKey) return false;
  const pairs = header.split(",").map((kv) => kv.split("=", 2) as [string, string | undefined]);
  const t = Number(pairs.find(([k]) => k === "t")?.[1]);
  const signatures = pairs.filter(([k, v]) => k === "v2" && v).map(([, v]) => Buffer.from(v ?? "", "hex"));
  if (!Number.isInteger(t) || signatures.length === 0) return false;
  if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return false;
  const expected = mac(secret, t, idempotencyKey, body);
  return signatures.some((given) => given.length === expected.length && timingSafeEqual(given, expected));
}
