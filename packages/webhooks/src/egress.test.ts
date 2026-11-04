import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { egressPolicy } from "@ai-triage/core/pipeline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGuardedFetch, isEgressBlocked } from "./egress";

// The connect-time SSRF guard: whatever a URL looked like when it was saved, the connection only
// goes to an address the policy allows (docs/security.md, M3).

let server: Server;
let port = 0;
beforeAll(async () => {
  server = createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

/** A resolver that answers every name with `ip`, standing in for DNS that rebinds. */
const resolvesTo =
  (ip: string) => (_host: string, cb: (err: Error | null, a: { address: string; family: number }[]) => void) =>
    cb(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the fetch to fail");
}

describe("createGuardedFetch", () => {
  it("refuses a public-looking hostname that resolves to a private address (DNS rebinding)", async () => {
    const guarded = createGuardedFetch(egressPolicy([]), resolvesTo("10.0.0.1"));
    expect(isEgressBlocked(await failure(guarded(`https://hooks.example.com:${port}/x`, { method: "POST" })))).toBe(
      true,
    );
  });

  it("refuses loopback, so the operator's own services stay out of reach", async () => {
    const guarded = createGuardedFetch(egressPolicy([]), resolvesTo("127.0.0.1"));
    expect(isEgressBlocked(await failure(guarded(`https://hooks.example.com:${port}/x`)))).toBe(true);
    expect(isEgressBlocked(await failure(guarded(`http://127.0.0.1:${port}/x`)))).toBe(true);
  });

  it("reaches an allowlisted private receiver", async () => {
    const guarded = createGuardedFetch(egressPolicy(["127.0.0.1"]));
    const res = await guarded(`http://127.0.0.1:${port}/x`);
    expect(await res.text()).toBe("ok");
  });

  it("checks addresses through the allowlist's CIDRs too", async () => {
    const guarded = createGuardedFetch(egressPolicy(["erp.internal", "127.0.0.0/8"]), resolvesTo("127.0.0.1"));
    expect(await (await guarded(`http://erp.internal:${port}/x`)).text()).toBe("ok");
  });
});
