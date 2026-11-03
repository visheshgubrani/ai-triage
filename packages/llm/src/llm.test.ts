import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmCallContext } from "@ai-triage/core";
import type { LlmRequest } from "@ai-triage/core/pipeline";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type AttemptRecord,
  CassetteMissError,
  type ChatCompletion,
  computeCostUsd,
  createLlmGateway,
  estimateWorstCaseUsd,
  fakeTransport,
  type Message,
  normalizeChatCompletion,
  normalizeMessage,
  type Price,
  readOutput,
  recordTransport,
  replayTransport,
  requestHash,
  toChatParams,
  toSdkParams,
  toWireRequest,
} from "./index";

const OPUS: Price = {
  id: "p-opus",
  inputPerMtok: 4,
  outputPerMtok: 20,
  cacheWrite5mPerMtok: 5,
  cacheWrite1hPerMtok: 8,
  cacheReadPerMtok: 0.2,
};
const SONNET: Price = { ...OPUS, id: "p-sonnet", inputPerMtok: 2, outputPerMtok: 10 };
const TERRA: Price = {
  id: "p-terra",
  inputPerMtok: 1,
  outputPerMtok: 5,
  cacheWrite5mPerMtok: 1,
  cacheWrite1hPerMtok: 1,
  cacheReadPerMtok: 0.05,
};
const PRICES: Record<string, Price> = {
  "claude-opus-5-5": OPUS,
  "claude-sonnet-5-5": SONNET,
  "openai:gpt-6.1-terra": TERRA,
};

const request = (overrides: Partial<LlmRequest> = {}): LlmRequest => ({
  stage: "classify",
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 4096,
  system: "Classify.",
  content: [
    { type: "text", text: '<part index="0">hello</part>' },
    { type: "document", mime: "application/pdf", data: "JVBERg==", title: "a.pdf", pages: 2 },
  ],
  outputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  ...overrides,
});

const message = (overrides: Partial<Message> = {}): Message =>
  ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: '{"category":"invoice"}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3000,
      cache_creation: null,
      iterations: null,
    },
    ...overrides,
  }) as unknown as Message;

describe("toSdkParams", () => {
  it("builds structured-output params with effort and server-side fallback", () => {
    expect(toSdkParams(request())).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      system: [{ type: "text", text: "Classify.", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
              title: "a.pdf",
            },
          ],
        },
      ],
      output_config: { effort: "low", format: { type: "json_schema" } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const params = toSdkParams(request()) as unknown as Record<string, unknown>;
    for (const key of ["temperature", "top_p", "top_k", "thinking"]) expect(params).not.toHaveProperty(key);
  });

  it("omits fallbacks on Haiku, which has none", () => {
    const params = toSdkParams(request({ model: "claude-haiku-5-5" }));
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("betas");
  });
});

describe("requestHash", () => {
  it("ignores key order and changes with content", () => {
    expect(requestHash({ a: 1, b: { c: 2, d: 3 } })).toBe(requestHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(requestHash(toWireRequest(request()))).not.toBe(requestHash(toWireRequest(request({ system: "Other." }))));
  });

  it("includes the provider, so equal params on two providers never share a cassette", () => {
    const params = toChatParams(request({ model: "openai:gpt-6.1-terra" }));
    expect(requestHash({ provider: "openai", params })).not.toBe(requestHash({ provider: "compat", params }));
  });
});

describe("cost", () => {
  it("prices input, output, both cache-write lifetimes and cache reads", () => {
    expect(computeCostUsd(normalizeMessage(message()).usage, OPUS)).toBeCloseTo(
      (1000 * 4 + 200 * 20 + 3000 * 0.2) / 1e6,
      12,
    );
    const { usage } = normalizeMessage(
      message({
        usage: {
          input_tokens: 10,
          output_tokens: 10,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 0,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        } as never,
      }),
    );
    const cost = computeCostUsd(usage, OPUS);
    expect(cost).toBeCloseTo((10 * 4 + 10 * 20 + 100 * 5 + 200 * 8) / 1e6, 12);
  });

  it("estimates the worst case from the prompt size, PDF pages and max_tokens", () => {
    const usd = estimateWorstCaseUsd(request(), OPUS);
    // 2 pages * 2000 tokens plus the text bytes / 2.5, at $4/MTok, plus 4096 output tokens at $20/MTok.
    expect(usd).toBeGreaterThan((4000 * 4 + 4096 * 20) / 1e6);
    expect(usd).toBeLessThan((4200 * 4 + 4096 * 20) / 1e6);
  });
});

describe("cassettes", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cassettes-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("records a response and replays it with its recorded latency, without base64 in the file", async () => {
    const wire = toWireRequest(request());
    const meta = { hash: requestHash(wire), stage: "classify" as const };
    await recordTransport(
      fakeTransport(() => message()),
      dir,
    ).send(wire, meta);
    const file = await readFile(join(dir, meta.hash.slice(0, 2), `${meta.hash}.json`), "utf8");
    expect(file).not.toContain("JVBERg==");
    expect(JSON.parse(file)).toMatchObject({ format: 2, provider: "anthropic", model: "claude-opus-5-5" });
    const replayed = await replayTransport(dir).send(wire, meta);
    expect(replayed).toMatchObject({ mode: "replay", latencyMs: 5, requestId: "req_fake_1" });
    expect((replayed.response as Message).id).toBe("msg_1");
  });

  it("strips base64 data URLs from OpenAI-compatible requests too", async () => {
    const wire = toWireRequest(request({ model: "openai:gpt-6.1-terra" }));
    const meta = { hash: requestHash(wire), stage: "classify" as const };
    await recordTransport(
      fakeTransport(() => completion()),
      dir,
    ).send(wire, meta);
    const file = await readFile(join(dir, meta.hash.slice(0, 2), `${meta.hash}.json`), "utf8");
    expect(file).not.toContain("JVBERg==");
    expect(file).toContain("<application/pdf, 8 base64 chars>");
    expect(JSON.parse(file)).toMatchObject({ provider: "openai", model: "gpt-6.1-terra" });
  });
});

const completion = (overrides: Partial<ChatCompletion> = {}, choice: Record<string, unknown> = {}): ChatCompletion =>
  ({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 0,
    model: "gpt-6.1-terra",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        logprobs: null,
        message: { role: "assistant", content: '{"category":"invoice"}', refusal: null },
        ...choice,
      },
    ],
    usage: {
      prompt_tokens: 4000,
      completion_tokens: 200,
      total_tokens: 4200,
      prompt_tokens_details: { cached_tokens: 3000 },
    },
    ...overrides,
  }) as ChatCompletion;

describe("OpenAI-compatible params", () => {
  it("sends a strict JSON Schema, file and image parts, max_completion_tokens and reasoning_effort to OpenAI", () => {
    const params = toChatParams(
      request({
        model: "openai:gpt-6.1-terra",
        effort: "none",
        content: [
          { type: "text", text: "hi" },
          { type: "document", mime: "application/pdf", data: "JVBERg==", title: "a.pdf", pages: 2 },
          { type: "image", mime: "image/png", data: "iVBO" },
        ],
      }),
    );
    expect(params).toEqual({
      model: "gpt-6.1-terra",
      messages: [
        { role: "system", content: "Classify." },
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "file", file: { filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERg==" } },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBO" } },
          ],
        },
      ],
      max_completion_tokens: 4096,
      response_format: {
        type: "json_schema",
        json_schema: { name: "classify", strict: true, schema: request().outputSchema },
      },
      reasoning_effort: "none",
    });
  });

  it("puts the schema in the system prompt for JSON-mode models (DeepSeek)", () => {
    const params = toChatParams(request({ model: "deepseek:deepseek-flash", effort: "high", content: [] }));
    expect(params).toMatchObject({
      model: "deepseek-flash",
      max_tokens: 4096,
      response_format: { type: "json_object" },
      reasoning_effort: "high",
    });
    expect(params.messages[0]?.content).toContain(
      `json object that matches this JSON Schema:\n${JSON.stringify(request().outputSchema)}`,
    );
  });

  it("asks OpenRouter for upstreams that honor every param, and leaves effort out for compat servers", () => {
    expect(toChatParams(request({ model: "openrouter:openai/gpt-6.1-terra", content: [] }))).toMatchObject({
      model: "openai/gpt-6.1-terra",
      reasoning: { effort: "low" },
      provider: { require_parameters: true },
    });
    const compat = toChatParams(request({ model: "compat:qwen3", effort: "none", content: [] }));
    expect(compat).toMatchObject({ model: "qwen3", max_tokens: 4096 });
    expect(compat).not.toHaveProperty("reasoning_effort");
    expect(compat).not.toHaveProperty("reasoning");
  });

  it("rejects an effort the model doesn't list", () => {
    expect(() => toChatParams(request({ model: "deepseek:deepseek-flash", effort: "medium" }))).toThrow(/effort/);
  });
});

describe("normalizeChatCompletion", () => {
  it("maps finish reasons to Claude's stop reasons and splits cached prompt tokens", () => {
    expect(normalizeChatCompletion(completion())).toMatchObject({
      stopReason: "end_turn",
      text: '{"category":"invoice"}',
      usage: { input: 1000, output: 200, cacheRead: 3000, cacheWrite5m: 0, cacheWrite1h: 0 },
      servedByFallback: false,
    });
    expect(normalizeChatCompletion(completion({}, { finish_reason: "length" })).stopReason).toBe("max_tokens");
    expect(normalizeChatCompletion(completion({}, { finish_reason: "content_filter" }))).toMatchObject({
      stopReason: "refusal",
      refusalCategory: "content_filter",
    });
    const refused = completion({}, { message: { role: "assistant", content: null, refusal: "I can't help." } });
    expect(() => readOutput(normalizeChatCompletion(refused), 4096)).toThrow(/declined/);
  });

  it("reads DeepSeek's cache-hit count", () => {
    const deepseek = completion({
      usage: { prompt_tokens: 500, completion_tokens: 10, total_tokens: 510, prompt_cache_hit_tokens: 400 } as never,
    });
    expect(normalizeChatCompletion(deepseek).usage).toMatchObject({ input: 100, cacheRead: 400 });
  });

  it("treats JSON mode's blank output as invalid", () => {
    const blank = completion({}, { message: { role: "assistant", content: "   ", refusal: null } });
    expect(() => readOutput(normalizeChatCompletion(blank), 4096)).toThrow(/not valid JSON/);
  });
});

/** An in-memory AttemptStore and budget, recording what the gateway does. */
function harness(
  mode: "live" | "replay" | "record",
  transport: ReturnType<typeof fakeTransport> = fakeTransport(() => message()),
) {
  const attempts: (AttemptRecord & { id: string })[] = [];
  const budget = { reserved: [] as number[], settled: [] as [number, number][], allow: true };
  const gateway = createLlmGateway({
    mode,
    transport,
    findPrice: async (model) => PRICES[model] ?? null,
    store: {
      findReusable: async (_t, _c, stage) =>
        attempts.findLast((a) => a.stage === stage && a.response && !a.error) ?? null,
      insert: async (_t, _c, a) => {
        const row = { ...a, id: `att-${attempts.length + 1}` };
        attempts.push(row);
        return row;
      },
    },
    budget: {
      reserve: async (_t, usd) => {
        if (!budget.allow) return null;
        budget.reserved.push(usd);
        return { day: "2026-11-03" };
      },
      settle: async (_t, _d, reserved, actual) => {
        budget.settled.push([reserved, actual]);
      },
    },
  });
  return { gateway, attempts, budget, transport };
}

const ctx: LlmCallContext = { runId: "run-1" };

describe("gateway", () => {
  it("saves the attempt with tokens and cost, settles the budget, and reuses the attempt on retry", async () => {
    const h = harness("live");
    const first = await h.gateway.call({ tenantId: "t", ctx, request: request() });
    expect(first).toEqual({ attemptId: "att-1", output: { category: "invoice" }, reused: false });
    expect(h.attempts[0]).toMatchObject({
      mode: "live",
      inputTokens: 1000,
      cacheReadInputTokens: 3000,
      priceId: "p-opus",
      error: null,
    });
    expect(h.attempts[0]?.costUsd).toBeCloseTo(0.0086, 10);
    expect(h.budget.settled).toEqual([[h.budget.reserved[0], h.attempts[0]?.costUsd]]);

    const again = await h.gateway.call({ tenantId: "t", ctx, request: request() });
    expect(again).toEqual({ attemptId: "att-1", output: { category: "invoice" }, reused: true });
    expect(h.transport.calls).toHaveLength(1);
  });

  it("fails on a missing cassette in replay, without touching the network or the budget", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dir = await mkdtemp(join(tmpdir(), "empty-"));
    const h = harness("replay", replayTransport(dir) as ReturnType<typeof fakeTransport>);
    await expect(h.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toBeInstanceOf(CassetteMissError);
    await expect(h.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toThrow(/pnpm cassettes:record/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.attempts).toEqual([]);
    expect(h.budget.reserved).toEqual([]);
    fetchSpy.mockRestore();
    await rm(dir, { recursive: true });
  });

  it("records refusals and truncations as failed attempts, then throws", async () => {
    const refusal = harness(
      "live",
      fakeTransport(() =>
        message({
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: null },
        } as never),
      ),
    );
    await expect(refusal.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toMatchObject({
      reason: "llm_refusal",
    });
    expect(refusal.attempts[0]).toMatchObject({ stopReason: "refusal", error: expect.stringContaining("cyber") });

    const truncated = harness(
      "live",
      fakeTransport(() => message({ stop_reason: "max_tokens" })),
    );
    await expect(truncated.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toMatchObject({
      reason: "llm_truncated",
    });
    // A failed attempt isn't reusable: the next call goes to Claude again.
    await expect(truncated.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toThrow();
    expect(truncated.transport.calls).toHaveLength(2);
  });

  it("refuses to call when the budget is exhausted", async () => {
    const h = harness("live");
    h.budget.allow = false;
    await expect(h.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toMatchObject({
      reason: "budget_exhausted",
    });
    expect(h.transport.calls).toHaveLength(0);
  });

  it("records an API error as an attempt and rethrows it for a retry", async () => {
    const h = harness(
      "live",
      fakeTransport(() => Promise.reject(new Error("overloaded"))),
    );
    await expect(h.gateway.call({ tenantId: "t", ctx, request: request() })).rejects.toThrow("overloaded");
    expect(h.attempts).toMatchObject([{ response: null, error: "Error: overloaded", costUsd: 0 }]);
    expect(h.budget.settled).toEqual([[h.budget.reserved[0], 0]]);
  });

  it("detects a fallback-served response and prices each hop at its own model", async () => {
    const hop = { cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const h = harness(
      "live",
      fakeTransport(() =>
        message({
          usage: {
            ...message().usage,
            iterations: [
              { ...hop, type: "message", model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 0 },
              { ...hop, type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 1000, output_tokens: 200 },
            ],
          } as never,
        }),
      ),
    );
    await h.gateway.call({ tenantId: "t", ctx, request: request() });
    expect(h.attempts[0]?.servedByFallback).toBe(true);
    expect(h.attempts[0]?.costUsd).toBeCloseTo((1000 * 4 + 1000 * 2 + 200 * 10) / 1e6, 12);
  });

  it("runs an OpenAI-compatible model through the same attempt, cost and reuse path", async () => {
    const h = harness(
      "live",
      fakeTransport(() => completion()),
    );
    const req = request({ model: "openai:gpt-6.1-terra" });
    const first = await h.gateway.call({ tenantId: "t", ctx, request: req });
    expect(first).toEqual({ attemptId: "att-1", output: { category: "invoice" }, reused: false });
    expect(h.transport.calls[0]?.request.provider).toBe("openai");
    expect(h.attempts[0]).toMatchObject({
      model: "openai:gpt-6.1-terra",
      inputTokens: 1000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 3000,
      stopReason: "end_turn",
      priceId: "p-terra",
    });
    expect(h.attempts[0]?.costUsd).toBeCloseTo((1000 * 1 + 200 * 5 + 3000 * 0.05) / 1e6, 12);
    const again = await h.gateway.call({ tenantId: "t", ctx, request: req });
    expect(again).toMatchObject({ attemptId: "att-1", reused: true });
    expect(h.transport.calls).toHaveLength(1);
  });

  it("won't call a model without a price, since the budget can't be reserved", async () => {
    const h = harness(
      "live",
      fakeTransport(() => completion()),
    );
    await expect(
      h.gateway.call({ tenantId: "t", ctx, request: request({ model: "compat:qwen3", effort: "none" }) }),
    ).rejects.toMatchObject({ reason: "llm_bad_request" });
    expect(h.transport.calls).toHaveLength(0);
  });
});
