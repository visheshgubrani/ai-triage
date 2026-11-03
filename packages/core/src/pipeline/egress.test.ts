import { describe, expect, it } from "vitest";
import { checkWebhookUrl, egressPolicy, egressPolicyFromEnv, isAllowedAddress, isPublicAddress } from "./egress";

const none = egressPolicy([]);

describe("isPublicAddress", () => {
  it.each([
    ["93.184.215.14", true],
    ["2606:4700:4700::1111", true],
    ["127.0.0.1", false],
    ["0.0.0.0", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false], // cloud metadata
    ["100.64.0.1", false], // CGNAT
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["::1", false],
    ["::", false],
    ["fd00::1", false], // unique local
    ["fe80::1", false],
    ["::ffff:127.0.0.1", false], // IPv4-mapped loopback
    ["::ffff:93.184.215.14", true],
    ["2002:7f00:1::", false], // 6to4 wrapping 127.0.0.1
    ["64:ff9b::a00:1", false], // NAT64 wrapping 10.0.0.1
    ["not-an-ip", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe("checkWebhookUrl", () => {
  it("accepts an https URL on a normal port", () => {
    expect(checkWebhookUrl("https://hooks.example.com/triage", none)).toMatchObject({
      ok: true,
      hostname: "hooks.example.com",
    });
    expect(checkWebhookUrl("https://hooks.example.com:8443/x", none).ok).toBe(true);
  });

  it.each([
    ["http://hooks.example.com/", "must use https"],
    ["ftp://hooks.example.com/", "must use https"],
    ["https://user:pw@hooks.example.com/", "must not contain credentials"],
    ["https://hooks.example.com:22/", "must use port 443"],
    ["https://127.0.0.1/", "private or reserved"],
    ["https://169.254.169.254/latest/meta-data", "private or reserved"],
    ["https://2130706433/", "private or reserved"], // decimal 127.0.0.1, normalized by URL
    ["https://0x7f.1/", "private or reserved"],
    ["https://[::ffff:10.0.0.1]/", "private or reserved"],
    ["https://[::1]/", "private or reserved"],
    ["nonsense", "not a valid URL"],
  ])("refuses %s", (url, reason) => {
    const check = checkWebhookUrl(url, none);
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.reason).toContain(reason);
  });

  it("lets allowlisted hosts use http and private addresses", () => {
    const policy = egressPolicy(["erp.internal", "10.20.0.0/16"]);
    expect(checkWebhookUrl("http://erp.internal:8080/hook", policy).ok).toBe(true);
    expect(checkWebhookUrl("http://10.20.3.4:8080/hook", policy).ok).toBe(true);
    expect(checkWebhookUrl("https://10.21.0.1/hook", policy).ok).toBe(false);
  });

  it("allows the demo catcher only under TRIAGE_DEMO", () => {
    expect(checkWebhookUrl("http://localhost:9030/hooks/demo", egressPolicyFromEnv({})).ok).toBe(false);
    expect(checkWebhookUrl("http://localhost:9030/hooks/demo", egressPolicyFromEnv({ TRIAGE_DEMO: "true" })).ok).toBe(
      true,
    );
  });
});

describe("isAllowedAddress", () => {
  it("checks what a hostname resolved to, unless the host is allowlisted", () => {
    expect(isAllowedAddress("10.0.0.1", "hooks.example.com", none)).toBe(false);
    expect(isAllowedAddress("93.184.215.14", "hooks.example.com", none)).toBe(true);
    expect(isAllowedAddress("10.0.0.1", "erp.internal", egressPolicy(["erp.internal"]))).toBe(true);
  });
});
