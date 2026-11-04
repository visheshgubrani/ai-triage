import { describe, expect, it } from "vitest";
import { generateInboundAddress, inboundBase } from "./tenants";

describe("inbound addresses", () => {
  it("are unguessable at a domain whose MX points at Postmark", () => {
    const a = generateInboundAddress("Inbound.Acme.test");
    expect(a).toMatch(/^t-[0-9a-f]{20}@inbound\.acme\.test$/);
    expect(generateInboundAddress("inbound.acme.test")).not.toBe(a);
    expect(inboundBase(a)).toBe("inbound.acme.test");
  });

  it("use plus addressing on a Postmark server's own address, and rotate within it", () => {
    const a = generateInboundAddress("ABC123@inbound.postmarkapp.com");
    expect(a).toMatch(/^abc123\+t-[0-9a-f]{20}@inbound\.postmarkapp\.com$/);
    expect(inboundBase(a)).toBe("abc123@inbound.postmarkapp.com");
    expect(generateInboundAddress(inboundBase(a) ?? "")).toMatch(/^abc123\+t-/);
  });
});
