import { describe, expect, it } from "vitest";
import { senderPasses, senderPolicy } from "../untrusted";
import { normalizeEml } from "./email";

// Which Authentication-Results count for mail synced from Gmail (phase 6, M6): only the ones Google
// wrote, found by position around Google's inbound hop. Header layout follows Gmail's raw messages:
// ARC results above the hop, Received-SPF and Authentication-Results just below it.

const google = (results: string) => [
  "Delivered-To: ap@acme.test",
  "Received: by 2002:a05:6a10:1234:b0:5c2:abcd with SMTP id x1csp1234567pxb; Tue, 3 Nov 2026 02:00:01 -0800 (PST)",
  "ARC-Seal: i=1; a=rsa-sha256; t=1793700000; cv=none; d=google.com; s=arc-20240605; b=abc",
  `ARC-Authentication-Results: i=1; mx.google.com;\r\n       ${results}`,
  "Return-Path: <bounce@vendor.test>",
  "Received: from mail.vendor.test (mail.vendor.test. [203.0.113.5])\r\n        by mx.google.com with ESMTPS id a1si123; Tue, 3 Nov 2026 02:00:00 -0800 (PST)",
  "Received-SPF: pass (google.com: domain of bounce@vendor.test designates 203.0.113.5 as permitted sender) client-ip=203.0.113.5;",
  `Authentication-Results: mx.google.com;\r\n       ${results}`,
];

const message = (trace: string[], sent: string[] = []) =>
  new TextEncoder().encode(
    [
      ...trace,
      ...sent,
      "From: Vendor <billing@vendor.test>",
      "To: ap@acme.test",
      "Subject: Invoice",
      "Message-ID: <inv-1@vendor.test>",
      "Content-Type: text/plain",
      "",
      "Invoice attached.",
      "",
    ].join("\r\n"),
  );

const PASS =
  "dkim=pass header.i=@vendor.test; spf=pass smtp.mailfrom=vendor.test; dmarc=pass (p=REJECT) header.from=vendor.test";
const FAIL =
  "dkim=fail header.i=@vendor.test; spf=softfail smtp.mailfrom=vendor.test; dmarc=fail (p=NONE) header.from=vendor.test";
const policy = senderPolicy({});

describe("Gmail-synced mail", () => {
  it("keeps Google's own results and passes an authenticated sender", async () => {
    const email = await normalizeEml(message(google(PASS)), { receivedBy: "google" });
    expect(email.receivedBy).toBe("google");
    expect(email.authResults).toHaveLength(2);
    expect(email.authResults.every((r) => r.startsWith("mx.google.com;"))).toBe(true);
    expect(senderPasses(email, policy)).toBe(true);
  });

  it("ignores results the sender wrote below Google's trace, whatever server they name", async () => {
    const forged = [
      `Authentication-Results: mx.google.com; ${PASS}`,
      `ARC-Authentication-Results: i=1; mx.google.com; ${PASS}`,
    ];
    const email = await normalizeEml(message(google(FAIL), forged), { receivedBy: "google" });
    expect(email.authResults.join("\n")).not.toContain("dmarc=pass");
    expect(senderPasses(email, policy)).toBe(false);
  });

  it("trusts a forged hop no more: Google's real hop is above it", async () => {
    const forgedHop = [
      "Received: from evil.test by mx.google.com with SMTP id fake",
      `Authentication-Results: mx.google.com; ${PASS}`,
    ];
    const email = await normalizeEml(message(google(FAIL), forgedHop), { receivedBy: "google" });
    expect(senderPasses(email, policy)).toBe(false);
  });

  it("trusts nothing without Google's inbound hop (internal mail), so it goes to review", async () => {
    const internal = [
      "Received: by 2002:a05:6a10:1234 with SMTP id x1; Tue, 3 Nov 2026 02:00:01 -0800 (PST)",
      `Authentication-Results: mx.google.com; ${PASS}`,
    ];
    const email = await normalizeEml(message(internal), { receivedBy: "google" });
    expect(email.authResults).toEqual([]);
    expect(senderPasses(email, policy)).toBe(false);
    expect(senderPasses(email, senderPolicy({ sender: { mailbox: { require: false } } }))).toBe(true);
  });

  it("leaves forwarded and uploaded mail as before: every header, no provider", async () => {
    const email = await normalizeEml(message(google(PASS)));
    expect(email.receivedBy).toBeUndefined();
    expect(email.authResults).toHaveLength(1);
    expect(senderPasses(email, policy)).toBe(true);
  });
});
