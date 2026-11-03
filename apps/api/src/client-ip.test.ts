import { describe, expect, it } from "vitest";
import { parseTrustedProxies, resolveClientIp } from "./client-ip";

describe("resolveClientIp", () => {
  const proxies = parseTrustedProxies("10.0.0.0/8, 192.0.2.10");

  it("uses the socket peer when no proxy is trusted, ignoring X-Forwarded-For", () => {
    expect(resolveClientIp("203.0.113.5", "1.2.3.4", [])).toBe("203.0.113.5");
  });

  it("ignores X-Forwarded-For from an untrusted peer", () => {
    expect(resolveClientIp("203.0.113.5", "1.2.3.4", proxies)).toBe("203.0.113.5");
  });

  it("walks the chain right to left past trusted hops", () => {
    expect(resolveClientIp("10.0.0.2", "198.51.100.7, 192.0.2.10", proxies)).toBe("198.51.100.7");
    // A client-supplied entry left of the real client is never reached.
    expect(resolveClientIp("10.0.0.2", "6.6.6.6, 198.51.100.7, 192.0.2.10", proxies)).toBe("198.51.100.7");
  });

  it("normalizes IPv4-mapped IPv6 peers", () => {
    expect(resolveClientIp("::ffff:10.0.0.2", "198.51.100.7", proxies)).toBe("198.51.100.7");
  });

  it("gives up on a malformed hop rather than trusting what lies beyond it", () => {
    expect(resolveClientIp("10.0.0.2", "198.51.100.7, garbage", proxies)).toBeNull();
  });
});
