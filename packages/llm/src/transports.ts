import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LlmCallMode, LlmStage, Provider } from "@ai-triage/core";
import { PipelineError } from "@ai-triage/core/pipeline";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { CassetteMissError, ProviderBusyError } from "./errors";
import { CASSETTE_FORMAT } from "./hash";
import type { OpenAiCompatibleProvider, WireRequest } from "./providers";

export interface SendResult {
  /** The provider's raw response (a Messages API message or a chat completion). */
  response: unknown;
  /** Wall-clock latency; in replay, the latency recorded when the cassette was made. */
  latencyMs: number;
  requestId: string | null;
  mode: LlmCallMode;
}

export interface RequestMeta {
  hash: string;
  stage: LlmStage;
  /** Aborts the call: the job expired, or the worker is shutting down. */
  signal?: AbortSignal;
  /** How long the provider may take (llmTimeoutMs). */
  timeoutMs?: number;
}

/** Sends one request. live and record call the provider; replay reads cassettes; fake is for tests. */
export interface Transport {
  send(request: WireRequest, meta: RequestMeta): Promise<SendResult>;
}

/** Where each OpenAI-compatible provider lives and which env vars configure it. */
export const OPENAI_COMPATIBLE_ENDPOINTS: Record<
  OpenAiCompatibleProvider,
  { keyEnv: string; baseUrlEnv: string; baseUrl: string | null; keyRequired: boolean }
> = {
  openai: { keyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", baseUrl: null, keyRequired: true },
  deepseek: {
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    baseUrl: "https://api.deepseek.com",
    keyRequired: true,
  },
  openrouter: {
    keyEnv: "OPENROUTER_API_KEY",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    baseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
  },
  // Local servers usually ignore the key.
  compat: { keyEnv: "OPENAI_COMPAT_API_KEY", baseUrlEnv: "OPENAI_COMPAT_BASE_URL", baseUrl: null, keyRequired: false },
  sim: { keyEnv: "LLM_SIMULATOR_KEY", baseUrlEnv: "LLM_SIMULATOR_URL", baseUrl: null, keyRequired: false },
};

/** The env var holding a provider's API key (for preflight checks such as the cassette recorder). */
export const providerKeyEnv = (provider: Provider) =>
  provider === "anthropic" ? "ANTHROPIC_API_KEY" : OPENAI_COMPATIBLE_ENDPOINTS[provider].keyEnv;

const missing = (name: string) => new PipelineError("llm_bad_request", `${name} is not set`);

function openAiClient(provider: OpenAiCompatibleProvider, env: NodeJS.ProcessEnv): OpenAI {
  const endpoint = OPENAI_COMPATIBLE_ENDPOINTS[provider];
  const apiKey = env[endpoint.keyEnv] || (endpoint.keyRequired ? undefined : "unused");
  if (!apiKey) throw missing(endpoint.keyEnv);
  const baseURL = env[endpoint.baseUrlEnv] || endpoint.baseUrl;
  if ((provider === "compat" || provider === "sim") && !baseURL) throw missing(endpoint.baseUrlEnv);
  // pg-boss owns retries (with backoff and a dead letter), so the SDK makes none of its own.
  return new OpenAI({ apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
}

/** Statuses that mean "too busy, come back later": rate limited, overloaded (Claude's 529), unavailable. */
const BUSY_STATUSES = new Set([429, 503, 529]);

/** The provider's Retry-After in milliseconds (`retry-after-ms`, or `retry-after` in seconds or as a date). */
export function retryAfterMs(headers: Headers | Record<string, string> | undefined, now = Date.now()): number | null {
  const get = (name: string) =>
    headers instanceof Headers ? headers.get(name) : (headers?.[name] ?? headers?.[name.toLowerCase()] ?? null);
  const ms = Number(get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const value = get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/**
 * Errors retrying can't fix become PipelineErrors, so the run fails at once. A busy provider
 * becomes a ProviderBusyError, which the gateway turns into a shared cooldown.
 */
function classify(err: unknown, sdk: typeof Anthropic | typeof OpenAI): unknown {
  if (err instanceof sdk.APIError && err.status !== undefined && BUSY_STATUSES.has(err.status)) {
    return new ProviderBusyError(err.status, retryAfterMs(err.headers as Headers | undefined), err.message);
  }
  if (err instanceof sdk.APIError && err.status === 413) return new PipelineError("request_too_large", err.message);
  if (
    err instanceof sdk.BadRequestError ||
    err instanceof sdk.NotFoundError ||
    err instanceof sdk.UnprocessableEntityError
  ) {
    return new PipelineError("llm_bad_request", err.message);
  }
  return err;
}

/**
 * Calls the provider's API: the Messages API for Claude, Chat Completions for the rest. Clients are
 * built on first use, so a missing key only matters for a provider a config actually uses. Errors
 * retrying can't fix (400, 404, 413, 422, a missing key) become PipelineErrors so the run fails at
 * once; rate limits, server errors, timeouts and connection errors propagate, and pg-boss retries the
 * job (the SDK retries nothing itself).
 */
export function liveTransport(options: { anthropic?: Anthropic; env?: NodeJS.ProcessEnv } = {}): Transport {
  const env = options.env ?? process.env;
  let anthropic = options.anthropic;
  const openai = new Map<OpenAiCompatibleProvider, OpenAI>();
  return {
    async send(request, meta) {
      const options = { signal: meta.signal, timeout: meta.timeoutMs, maxRetries: 0 };
      const started = performance.now();
      const done = (response: unknown, requestId: string | null): SendResult => ({
        response,
        latencyMs: Math.round(performance.now() - started),
        requestId,
        mode: request.provider === "sim" ? "simulated" : "live",
      });
      if (request.provider === "anthropic") {
        if (!anthropic) {
          if (!env.ANTHROPIC_API_KEY) throw missing("ANTHROPIC_API_KEY");
          anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
        }
        try {
          const { data, request_id } = await anthropic.beta.messages.create(request.params, options).withResponse();
          return done(data, request_id ?? null);
        } catch (err) {
          throw classify(err, Anthropic);
        }
      }
      let client = openai.get(request.provider);
      if (!client) {
        client = openAiClient(request.provider, env);
        openai.set(request.provider, client);
      }
      try {
        const { data, request_id } = await client.chat.completions.create(request.params, options).withResponse();
        return done(data, request_id ?? data.id ?? null);
      } catch (err) {
        throw classify(err, OpenAI);
      }
    },
  };
}

export interface Cassette {
  format: number;
  hash: string;
  provider: Provider;
  stage: LlmStage;
  model: string;
  recordedAt: string;
  latencyMs: number;
  requestId: string | null;
  /** What was asked, without base64 payloads, for reviewing a cassette diff. */
  request: unknown;
  /** The provider's raw response. */
  response: unknown;
}

export const cassettePath = (dir: string, hash: string) => join(dir, hash.slice(0, 2), `${hash}.json`);

/** The params with document and image data (raw or as data: URLs) replaced by their size. */
function summarize(params: unknown): unknown {
  return JSON.parse(
    JSON.stringify(params, (key, value) => {
      if (key === "schema") return "<schema>";
      if (typeof value !== "string") return value;
      if (key === "data") return `<${value.length} base64 chars>`;
      const dataUrl = value.match(/^data:([^;,]+);base64,/);
      return dataUrl ? `<${dataUrl[1]}, ${value.length - dataUrl[0].length} base64 chars>` : value;
    }),
  );
}

/** Calls through `inner` (live) and writes each response as a cassette keyed by request hash. */
export function recordTransport(inner: Transport, dir: string): Transport {
  return {
    async send(request, meta) {
      const result = await inner.send(request, meta);
      const cassette: Cassette = {
        format: CASSETTE_FORMAT,
        hash: meta.hash,
        provider: request.provider,
        stage: meta.stage,
        model: request.params.model,
        recordedAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
        requestId: result.requestId,
        request: summarize(request.params),
        response: result.response,
      };
      const path = cassettePath(dir, meta.hash);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, `${JSON.stringify(cassette, null, 2)}\n`);
      await rename(`${path}.tmp`, path);
      return result;
    },
  };
}

/** Serves recorded responses. A missing cassette is a hard error, never a live call. */
export function replayTransport(dir: string): Transport {
  return {
    async send(_request, meta) {
      let raw: string;
      try {
        raw = await readFile(cassettePath(dir, meta.hash), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CassetteMissError(meta.hash, meta.stage);
        throw err;
      }
      const cassette = JSON.parse(raw) as Cassette;
      return {
        response: cassette.response,
        latencyMs: cassette.latencyMs,
        requestId: cassette.requestId,
        mode: "replay",
      };
    },
  };
}

/** Scripted raw responses for tests; records every call. */
export function fakeTransport(respond: (request: WireRequest, meta: RequestMeta) => unknown) {
  const calls: { request: WireRequest; meta: RequestMeta }[] = [];
  const transport: Transport & { calls: typeof calls } = {
    calls,
    async send(request, meta) {
      calls.push({ request, meta });
      return {
        response: await respond(request, meta),
        latencyMs: 5,
        requestId: `req_fake_${calls.length}`,
        mode: "live",
      };
    },
  };
  return transport;
}
