import { randomUUID } from "node:crypto";
import { fakeTransport, type Message } from "@ai-triage/llm";
import { TEMPLATES, toJsonSchema } from "@ai-triage/schemas";

// A scripted model for tests: each request names its scenario in the document text
// (`SCENARIO clear-invoice`), and the transport answers with that scenario's classify or extract
// output, as Claude or an OpenAI-compatible provider would send it.

const fields = (category: string) =>
  Object.keys((toJsonSchema(TEMPLATES[category] ?? (undefined as never)).properties ?? {}) as object);

export function envelope(
  category: string,
  values: Record<string, unknown>,
  quotes: Record<string, string | [string, number]>,
  uncertain: string[] = [],
) {
  return {
    fields: Object.fromEntries(
      fields(category).map((f) => {
        const q = quotes[f];
        const evidence =
          q === undefined ? null : Array.isArray(q) ? { quote: q[0], page: q[1] } : { quote: q, page: null };
        return [f, { value: values[f] ?? null, evidence }];
      }),
    ),
    uncertain_fields: uncertain,
  };
}

export const SCENARIOS: Record<string, { classify: unknown; extract?: unknown; refuse?: boolean }> = {
  "clear-invoice": {
    classify: { category: "invoice", self_confidence: 0.97, rationale: "An invoice." },
    extract: envelope(
      "invoice",
      { vendor_name: "Acme Supplies Ltd", invoice_number: "INV-9", invoice_date: "2026-10-01", total: 120 },
      {
        vendor_name: "Acme Supplies Ltd",
        invoice_number: "Invoice INV-9",
        invoice_date: "dated 2026-10-01",
        total: "Total: 120.00",
      },
    ),
  },
  "unsure-support": {
    classify: { category: "support_request", self_confidence: 0.6, rationale: "Maybe support." },
    extract: envelope(
      "support_request",
      {
        customer_email: "jane@example.test",
        issue_summary: "Order is late",
        severity: "medium",
        requested_action: "information",
      },
      { customer_email: "jane@example.test" },
    ),
  },
  contract: {
    classify: { category: "contract", self_confidence: 0.95, rationale: "An NDA." },
    extract: envelope(
      "contract",
      {
        contract_type: "nda",
        parties: [{ name: "Northwind Ltd" }, { name: "Contoso GmbH" }],
        effective_date: "2026-03-01",
      },
      { effective_date: "effective 1 March 2026" },
    ),
  },
  newsletter: { classify: { category: "other", self_confidence: 0.9, rationale: "Marketing." } },
  refusal: { classify: null, refuse: true },
  "pdf-invoice": {
    classify: { category: "invoice", self_confidence: 0.98, rationale: "Invoice attached." },
    extract: envelope(
      "invoice",
      { vendor_name: "Globex Corporation", invoice_number: "GX-2026-114", invoice_date: "2026-09-30", total: 480.5 },
      {
        vendor_name: ["Globex Corporation", 1],
        invoice_number: ["Invoice GX-2026-114", 1],
        invoice_date: ["Issued 2026-09-30", 1],
        total: ["Amount due: 480.50", 1],
      },
    ),
  },
};

export function reply(output: unknown, overrides: Partial<Message> = {}): Message {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(output), citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1200,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      iterations: null,
    },
    ...overrides,
  } as unknown as Message;
}

export function scripted() {
  return fakeTransport((request, meta) => {
    const name = JSON.stringify(request.params.messages).match(/SCENARIO ([a-z-]+)/)?.[1] ?? "";
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`no scenario in request (${name})`);
    const output = meta.stage === "classify" ? scenario.classify : scenario.extract;
    if (request.provider !== "anthropic") {
      // A Chat Completions response, as OpenAI-compatible providers send it.
      return {
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        created: 0,
        model: request.params.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: { role: "assistant", content: JSON.stringify(output), refusal: null },
          },
        ],
        usage: { prompt_tokens: 1200, completion_tokens: 150, total_tokens: 1350 },
      };
    }
    if (scenario.refuse) {
      return reply(null, {
        content: [],
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
      } as never);
    }
    return reply(output);
  });
}

/** Document texts that trigger each scenario (their quotes are what the scripted extractions cite). */
export const TEXT = {
  invoice: "SCENARIO clear-invoice\nAcme Supplies Ltd\nInvoice INV-9 dated 2026-10-01\nTotal: 120.00",
  support: "SCENARIO unsure-support\nFrom jane@example.test: my order 55 is late",
  contract: "SCENARIO contract\nMutual NDA between Northwind Ltd and Contoso GmbH, effective 1 March 2026.",
  newsletter: "SCENARIO newsletter\nJoin our autumn webinar series!",
  refusal: "SCENARIO refusal\nSomething the model declines.",
};
