import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { checkWebhookUrl, type EgressPolicy, isAllowedAddress } from "@ai-triage/core/pipeline";
import { Agent, fetch as undiciFetch } from "undici";

// Webhook egress at connect time (docs/security.md, SSRF). The api checks a URL's DNS when it is
// saved, but a hostname can resolve differently later (DNS rebinding), so every connection resolves
// through this lookup, which refuses the connection if any address it got isn't allowed. IP-literal
// URLs skip DNS entirely; checkWebhookUrl() covers those before the request is made.

export class EgressBlockedError extends Error {
  override name = "EgressBlockedError";
}

type Resolver = (hostname: string, callback: (err: Error | null, addresses: LookupAddress[]) => void) => void;

const systemResolver: Resolver = (hostname, callback) =>
  dnsLookup(hostname, { all: true }, (err, addresses) => callback(err, addresses ?? []));

/** A net/tls `lookup` that only hands out allowed addresses. `resolve` is injectable for tests. */
export function guardedLookup(policy: EgressPolicy, resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (err, addresses) => {
      const cb = callback as (err: Error | null, address: string | LookupAddress[], family?: number) => void;
      if (err) return cb(err, "", 0);
      const blocked = addresses.find((a) => !isAllowedAddress(a.address, hostname, policy));
      if (blocked || addresses.length === 0) {
        return cb(new EgressBlockedError(`${hostname} resolves to a private or reserved address`), "", 0);
      }
      const wanted =
        options.family === 4 || options.family === 6 ? addresses.filter((a) => a.family === options.family) : addresses;
      const [first] = wanted;
      if (!first) return cb(new EgressBlockedError(`${hostname} has no address of the requested family`), "", 0);
      return options.all ? cb(null, wanted) : cb(null, first.address, first.family);
    });
  };
}

/** True when a fetch failed because the egress policy refused the destination. */
export function isEgressBlocked(err: unknown): boolean {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof EgressBlockedError) return true;
  }
  return false;
}

/**
 * fetch for webhook delivery: the URL is checked first (scheme, credentials, port, IP literals),
 * and every connection goes through guardedLookup.
 */
export function createGuardedFetch(policy: EgressPolicy, resolve?: Resolver): typeof fetch {
  const agent = new Agent({ connect: { lookup: guardedLookup(policy, resolve) } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const check = checkWebhookUrl(url, policy);
    if (!check.ok)
      throw new TypeError("fetch failed", { cause: new EgressBlockedError(`webhook URL ${check.reason}`) });
    return undiciFetch(url, { ...(init as object), dispatcher: agent });
  }) as unknown as typeof fetch;
}
