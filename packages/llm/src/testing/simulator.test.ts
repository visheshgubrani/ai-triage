import {
  buildClassifyRequest,
  buildExtractRequest,
  parseClassifyOutput,
  parseExtractOutput,
} from "@ai-triage/core/pipeline";
import { CLASSIFY_PROMPT_V1, EXTRACT_PROMPT_V1, getTemplate, toJsonSchema } from "@ai-triage/schemas";
import { describe, expect, it } from "vitest";
import { normalizeChatCompletion, readOutput, toChatParams } from "../index";
import { DEFAULT_SIMULATOR_OPTIONS, simulate } from "./simulator";

const model = { model: "sim:simulated" as const, effort: "none" as const, maxTokens: 4096 };
const quiet = { ...DEFAULT_SIMULATOR_OPTIONS, latencyMs: 0, jitterMs: 0 };
const invoice = toJsonSchema(getTemplate("invoice", 1)!);
const support = toJsonSchema(getTemplate("support_request", 1)!);
const categories = [
  { name: "invoice", description: "A bill from a supplier asking for payment." },
  { name: "support_request", description: "A customer asking for help with a product, order or account." },
];
const part = (text: string) => ({
  partIndex: 0,
  kind: "email_body" as const,
  mime: "text/plain",
  label: null,
  page: null,
  text,
  evidenceMode: "text" as const,
  storageKey: null,
});

const INVOICE_TEXT = `Subject: Invoice INV-2291
From: ap@vendor.test
Invoice number: INV-2291
Invoice date: 2026-10-01
Vendor name: Northwind Supplies
Total: 1240.00
Please pay this invoice by 2026-10-31.`;

function answer(request: ReturnType<typeof buildClassifyRequest>, options = quiet) {
  const res = simulate(toChatParams(request), options, () => 0.99);
  return { res, output: res.status === 200 ? readOutput(normalizeChatCompletion(res.body as never), 4096) : null };
}

describe("simulator", () => {
  it("classifies by the category terms the document uses, within the offered enum", () => {
    const request = buildClassifyRequest({
      model,
      promptBody: CLASSIFY_PROMPT_V1,
      categories,
      parts: [part(INVOICE_TEXT)],
      blobs: new Map(),
    });
    const { output } = answer(request);
    const parsed = parseClassifyOutput(output, ["invoice", "support_request", "other"]);
    expect(parsed.category).toBe("invoice");
    expect(parsed.selfConfidence).toBeGreaterThan(0.5);
  });

  it("says other when no category fits", () => {
    const request = buildClassifyRequest({
      model,
      promptBody: CLASSIFY_PROMPT_V1,
      categories,
      parts: [part("Lunch on Friday?")],
      blobs: new Map(),
    });
    expect(parseClassifyOutput(answer(request).output, ["invoice", "support_request", "other"]).category).toBe("other");
  });

  it("extracts schema-valid fields, quoting values that appear in the text", () => {
    const request = buildExtractRequest({
      model,
      promptBody: EXTRACT_PROMPT_V1,
      category: "invoice",
      schema: invoice,
      parts: [part(INVOICE_TEXT)],
      blobs: new Map(),
    });
    const parsed = parseExtractOutput(answer(request).output, invoice);
    expect(parsed.values).toMatchObject({ invoice_number: "INV-2291", invoice_date: "2026-10-01", total: 1240 });
    expect(parsed.evidence.invoice_number?.quote).toBe("INV-2291");
    expect(INVOICE_TEXT).toContain(parsed.evidence.vendor_name?.quote ?? "");
  });

  it("fills any category's schema, enums and lists included", () => {
    const request = buildExtractRequest({
      model,
      promptBody: EXTRACT_PROMPT_V1,
      category: "support_request",
      schema: support,
      parts: [part("Customer email: jo@example.com\nMy order 4411 arrived broken, please send a replacement.")],
      blobs: new Map(),
    });
    const parsed = parseExtractOutput(answer(request).output, support);
    expect(parsed.values.customer_email).toBe("jo@example.com");
    expect(parsed.values.requested_action).toBe("replacement");
  });

  it("is deterministic for a request, and injects faults at the configured rates", () => {
    const request = buildClassifyRequest({
      model,
      promptBody: CLASSIFY_PROMPT_V1,
      categories,
      parts: [part(INVOICE_TEXT)],
      blobs: new Map(),
    });
    expect(answer(request).output).toEqual(answer(request).output);
    const busy = simulate(toChatParams(request), { ...quiet, rate429: 1, retryAfterSeconds: 7 });
    expect(busy).toMatchObject({ status: 429, headers: { "retry-after": "7" } });
    const broken = simulate(toChatParams(request), { ...quiet, rate500: 1 });
    expect(broken.status).toBe(500);
  });
});
