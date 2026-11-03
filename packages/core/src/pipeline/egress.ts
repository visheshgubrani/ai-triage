import ipaddr from "ipaddr.js";

// Outbound webhook policy (docs/security.md, SSRF). A tenant admin chooses the webhook URL, so on a
// hosted instance it must not reach the operator's network: only https, ordinary ports, and hosts
// that resolve to public unicast addresses. Operators whose receivers live on a private network
// list them in WEBHOOK_ALLOWED_HOSTS (hostnames or CIDRs); those may also use http.
// Pure: the api checks DNS at save time, and the worker checks every resolved address at connect
// time (DNS rebinding), both with these functions.

type Addr = ipaddr.IPv4 | ipaddr.IPv6;

export interface EgressPolicy {
  /** Lower-case hostnames allowed whatever they resolve to. */
  hosts: readonly string[];
  /** Address ranges allowed even when private. */
  cidrs: readonly [Addr, number][];
}

/** Hosts the local demo delivers to (the compose webhook catcher, or localhost in `pnpm dev`). */
export const DEMO_WEBHOOK_HOSTS = ["localhost", "127.0.0.1", "::1", "webhook-catcher"] as const;

export function egressPolicy(allowed: readonly string[]): EgressPolicy {
  const hosts: string[] = [];
  const cidrs: [Addr, number][] = [];
  for (const raw of allowed.map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (raw.includes("/")) cidrs.push(ipaddr.parseCIDR(raw));
    else if (ipaddr.isValid(raw)) {
      const addr = unmap(ipaddr.parse(raw));
      cidrs.push([addr, addr.kind() === "ipv4" ? 32 : 128]);
      hosts.push(raw);
    } else hosts.push(raw);
  }
  return { hosts, cidrs };
}

/** WEBHOOK_ALLOWED_HOSTS, plus the demo hosts when TRIAGE_DEMO=true. */
export function egressPolicyFromEnv(env: Record<string, string | undefined>): EgressPolicy {
  const listed = (env.WEBHOOK_ALLOWED_HOSTS ?? "").split(",");
  return egressPolicy(env.TRIAGE_DEMO === "true" ? [...listed, ...DEMO_WEBHOOK_HOSTS] : listed);
}

const unmap = (addr: Addr): Addr =>
  addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress() ? (addr as ipaddr.IPv6).toIPv4Address() : addr;

/**
 * Public unicast only. Loopback, private, link-local (cloud metadata at 169.254.169.254), CGNAT,
 * multicast, reserved, unique-local, and IPv6 forms that embed an IPv4 address (6to4, Teredo,
 * NAT64) are not, because they can lead back into a private network.
 */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  return unmap(ipaddr.parse(ip)).range() === "unicast";
}

const hostAllowed = (hostname: string, policy: EgressPolicy) => policy.hosts.includes(hostname.toLowerCase());

/** May a connection to `hostname` go to this resolved address? */
export function isAllowedAddress(ip: string, hostname: string, policy: EgressPolicy): boolean {
  if (hostAllowed(hostname, policy)) return true;
  if (!ipaddr.isValid(ip)) return false;
  const addr = unmap(ipaddr.parse(ip));
  if (policy.cidrs.some(([range, bits]) => range.kind() === addr.kind() && addr.match(range, bits))) return true;
  return addr.range() === "unicast";
}

export type WebhookUrlCheck = { ok: true; url: URL; hostname: string } | { ok: false; reason: string };

/** Ports a receiver may listen on: the defaults, 8443, and any unprivileged port. */
const portAllowed = (port: string) => port === "" || port === "443" || port === "8443" || Number(port) >= 1024;

/**
 * The URL itself, before any DNS: scheme, credentials, port, and IP literals. A hostname still has
 * to resolve to allowed addresses (checked by the caller with isAllowedAddress).
 */
export function checkWebhookUrl(raw: string, policy: EgressPolicy): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "is not a valid URL" };
  }
  // URL keeps IPv6 literals in brackets.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  const allowedHost =
    hostAllowed(hostname, policy) || (ipaddr.isValid(hostname) && isAllowedAddress(hostname, hostname, policy));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowedHost)) {
    return { ok: false, reason: "must use https" };
  }
  if (url.username || url.password) return { ok: false, reason: "must not contain credentials" };
  if (!portAllowed(url.port)) return { ok: false, reason: "must use port 443, 8443 or a port above 1023" };
  if (ipaddr.isValid(hostname) && !isAllowedAddress(hostname, hostname, policy)) {
    return { ok: false, reason: "points at a private or reserved address" };
  }
  return { ok: true, url, hostname };
}
