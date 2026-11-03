import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import ipaddr from "ipaddr.js";

// The client's address for audit events and rate limits. Behind proxies, X-Forwarded-For is
// walked right to left, skipping trusted hops (TRUSTED_PROXIES: addresses or CIDRs, the same
// model Better Auth uses); the first untrusted address is the client. Without trusted proxies the
// header is ignored, since any client can set it.

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

export function parseTrustedProxies(value: string | undefined): Cidr[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => (entry.includes("/") ? ipaddr.parseCIDR(entry) : toCidr(ipaddr.parse(entry))));
}

const toCidr = (addr: ipaddr.IPv4 | ipaddr.IPv6): Cidr => [addr, addr.kind() === "ipv4" ? 32 : 128];

function normalize(raw: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    const addr = ipaddr.parse(raw.trim());
    return addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()
      ? (addr as ipaddr.IPv6).toIPv4Address()
      : addr;
  } catch {
    return null;
  }
}

const isTrusted = (addr: ipaddr.IPv4 | ipaddr.IPv6, trusted: Cidr[]) =>
  trusted.some(([range, bits]) => addr.kind() === range.kind() && addr.match(range, bits));

/** Pure: the client address from the socket peer and the forwarded chain. */
export function resolveClientIp(peer: string | null, forwardedFor: string | null, trusted: Cidr[]): string | null {
  const direct = peer ? normalize(peer) : null;
  if (!direct || !isTrusted(direct, trusted) || !forwardedFor) return direct?.toString() ?? null;
  const chain = forwardedFor.split(",").map(normalize);
  for (let i = chain.length - 1; i >= 0; i--) {
    const hop = chain[i];
    if (!hop) return null;
    if (!isTrusted(hop, trusted)) return hop.toString();
  }
  return chain[0]?.toString() ?? null;
}

export function clientIp(c: Context, trusted: Cidr[]): string | null {
  let peer: string | null = null;
  try {
    peer = getConnInfo(c).remote.address ?? null;
  } catch {
    // No Node socket (app.request in tests).
  }
  return resolveClientIp(peer, c.req.header("x-forwarded-for") ?? null, trusted);
}
