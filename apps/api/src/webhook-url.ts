import { lookup } from "node:dns/promises";
import { checkWebhookUrl, type EgressPolicy, isAllowedAddress } from "@ai-triage/core/pipeline";

// Save-time check of a webhook URL (docs/security.md, SSRF): the URL itself, then every address its
// host resolves to now. The worker checks the addresses again at connect time, since DNS can change.

export interface WebhookEgress {
  policy: EgressPolicy;
  /** Every address a hostname resolves to (DNS in production, a stub in tests). */
  resolve: (hostname: string) => Promise<string[]>;
}

export const systemResolve = async (hostname: string) => (await lookup(hostname, { all: true })).map((a) => a.address);

/** Why the URL can't be used as a webhook target, or null if it can. */
export async function webhookUrlProblem(raw: string, egress: WebhookEgress): Promise<string | null> {
  const check = checkWebhookUrl(raw, egress.policy);
  if (!check.ok) return check.reason;
  let addresses: string[];
  try {
    addresses = await egress.resolve(check.hostname);
  } catch {
    return "has a host name that doesn't resolve";
  }
  if (addresses.length === 0) return "has a host name that doesn't resolve";
  return addresses.every((a) => isAllowedAddress(a, check.hostname, egress.policy))
    ? null
    : "resolves to a private or reserved address";
}
