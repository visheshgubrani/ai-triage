import { describe, expect, it } from "vitest";
import { DEFAULT_INTAKE_FILTERS } from "../index";
import { intakeSkip, mailSignals } from "./intake";
import { normalizeEml } from "./parse/email";

const eml = (headers: string[], body = "Hello") =>
  new TextEncoder().encode(
    [...headers, "From: a@example.com", "To: b@example.com", "Subject: x", "", body, ""].join("\r\n"),
  );

describe("intake filters", () => {
  it("recognize auto-replies, bounces and bulk mail by their headers", () => {
    const signals = (headers: [string, string][]) => mailSignals(headers.map(([name, value]) => ({ name, value })));
    expect(intakeSkip(signals([["Auto-Submitted", "auto-replied"]]), DEFAULT_INTAKE_FILTERS)).toBe("auto_replies");
    expect(intakeSkip(signals([["X-Autoreply", "yes"]]), DEFAULT_INTAKE_FILTERS)).toBe("auto_replies");
    expect(intakeSkip(signals([["Precedence", "auto_reply"]]), DEFAULT_INTAKE_FILTERS)).toBe("auto_replies");
    expect(
      intakeSkip(
        signals([["Content-Type", 'multipart/report; report-type="delivery-status"; boundary=x']]),
        DEFAULT_INTAKE_FILTERS,
      ),
    ).toBe("bounces");
    // Bulk is off by default: some vendors send invoices from bulk mailers.
    const bulk = signals([["List-Unsubscribe", "<mailto:u@example.com>"]]);
    expect(intakeSkip(bulk, DEFAULT_INTAKE_FILTERS)).toBeNull();
    expect(intakeSkip(bulk, { ...DEFAULT_INTAKE_FILTERS, bulk: true })).toBe("bulk");
  });

  it("ignore Auto-Submitted: no, and mail with none of these headers", () => {
    expect(mailSignals([{ name: "Auto-Submitted", value: "no" }])).toBeUndefined();
    expect(intakeSkip(undefined, DEFAULT_INTAKE_FILTERS)).toBeNull();
  });

  it("are read when an .eml is normalized, and stay absent when there are none", async () => {
    const ooo = await normalizeEml(eml(["Auto-Submitted: auto-replied"]));
    expect(ooo.signals).toEqual({ autoSubmitted: "auto-replied" });
    const plain = await normalizeEml(eml([]));
    expect(plain).not.toHaveProperty("signals");
  });
});
