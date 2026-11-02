import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LlmCallMode, LlmStage } from "@ai-triage/core";
import { PipelineError } from "@ai-triage/core/pipeline";
import Anthropic from "@anthropic-ai/sdk";
import { CassetteMissError } from "./errors";
import { CASSETTE_FORMAT } from "./hash";
import type { MessageParams } from "./params";

export type Message = Anthropic.Beta.Messages.BetaMessage;

export interface SendResult {
  message: Message;
  /** Wall-clock latency; in replay, the latency recorded when the cassette was made. */
  latencyMs: number;
  requestId: string | null;
  mode: LlmCallMode;
}

export interface RequestMeta {
  hash: string;
  stage: LlmStage;
}

/** Sends one request. live and record call Claude; replay reads cassettes; fake is for tests. */
export interface Transport {
  send(params: MessageParams, meta: RequestMeta): Promise<SendResult>;
}

/**
 * Calls the Messages API. Errors retrying can't fix (400, 404, 413, 422) become PipelineErrors so
 * the run fails at once; rate limits, server errors and connection errors propagate for a retry
 * (after the SDK's own retries).
 */
export function liveTransport(client: Anthropic = new Anthropic()): Transport {
  return {
    async send(params) {
      const started = performance.now();
      try {
        const { data, request_id } = await client.beta.messages.create(params).withResponse();
        return {
          message: data,
          latencyMs: Math.round(performance.now() - started),
          requestId: request_id ?? null,
          mode: "live",
        };
      } catch (err) {
        if (err instanceof Anthropic.APIError && err.status === 413) {
          throw new PipelineError("request_too_large", err.message);
        }
        if (
          err instanceof Anthropic.BadRequestError ||
          err instanceof Anthropic.NotFoundError ||
          err instanceof Anthropic.UnprocessableEntityError
        ) {
          throw new PipelineError("llm_bad_request", err.message);
        }
        throw err;
      }
    },
  };
}

export interface Cassette {
  format: number;
  hash: string;
  stage: LlmStage;
  model: string;
  recordedAt: string;
  latencyMs: number;
  requestId: string | null;
  /** What was asked, without base64 payloads, for reviewing a cassette diff. */
  request: unknown;
  response: Message;
}

export const cassettePath = (dir: string, hash: string) => join(dir, hash.slice(0, 2), `${hash}.json`);

/** The params with document and image data replaced by their size, for a readable cassette. */
function summarize(params: MessageParams): unknown {
  return JSON.parse(
    JSON.stringify(params, (key, value) =>
      key === "data" && typeof value === "string"
        ? `<${value.length} base64 chars>`
        : key === "schema"
          ? "<schema>"
          : value,
    ),
  );
}

/** Calls through `inner` (live) and writes each response as a cassette keyed by request hash. */
export function recordTransport(inner: Transport, dir: string): Transport {
  return {
    async send(params, meta) {
      const result = await inner.send(params, meta);
      const cassette: Cassette = {
        format: CASSETTE_FORMAT,
        hash: meta.hash,
        stage: meta.stage,
        model: params.model,
        recordedAt: new Date().toISOString(),
        latencyMs: result.latencyMs,
        requestId: result.requestId,
        request: summarize(params),
        response: result.message,
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
    async send(_params, meta) {
      let raw: string;
      try {
        raw = await readFile(cassettePath(dir, meta.hash), "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new CassetteMissError(meta.hash, meta.stage);
        throw err;
      }
      const cassette = JSON.parse(raw) as Cassette;
      return {
        message: cassette.response,
        latencyMs: cassette.latencyMs,
        requestId: cassette.requestId,
        mode: "replay",
      };
    },
  };
}

/** Scripted responses for tests; records every call. */
export function fakeTransport(respond: (params: MessageParams, meta: RequestMeta) => Message | Promise<Message>) {
  const calls: { params: MessageParams; meta: RequestMeta }[] = [];
  const transport: Transport & { calls: typeof calls } = {
    calls,
    async send(params, meta) {
      calls.push({ params, meta });
      return {
        message: await respond(params, meta),
        latencyMs: 5,
        requestId: `req_fake_${calls.length}`,
        mode: "live",
      };
    },
  };
  return transport;
}
