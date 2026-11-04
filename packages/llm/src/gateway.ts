import { setTimeout as sleep } from "node:timers/promises";
import { type LlmCallContext, type LlmCallMode, type LlmStage, llmTimeoutMs } from "@ai-triage/core";
import { type LlmRequest, PipelineError } from "@ai-triage/core/pipeline";
import { estimatePromptTokens, estimateWorstCaseUsd, type FindPrice, responseCostUsd } from "./cost";
import { BudgetExhaustedError, ProviderBusyError, ProviderCoolingDownError } from "./errors";
import { requestHash } from "./hash";
import type { LlmMode } from "./index";
import { readOutput } from "./output";
import { type NormalizedResponse, normalizeResponse, toWireRequest } from "./providers";
import type { Transport } from "./transports";

/** One llm_calls row as the gateway writes it (packages/db `NewLlmAttempt`). */
export interface AttemptRecord {
  stage: LlmStage;
  mode: LlmCallMode;
  model: string;
  effort: string;
  requestHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number | null;
  priceId: string | null;
  latencyMs: number | null;
  stopReason: string | null;
  servedByFallback: boolean;
  requestId: string | null;
  response: unknown;
  error: string | null;
}

/** Persistence for attempts. The worker implements it with packages/db (llm_calls). */
export interface AttemptStore {
  /** The latest attempt with a response and no error for (context, stage). */
  findReusable(
    tenantId: string,
    ctx: LlmCallContext,
    stage: LlmStage,
  ): Promise<{ id: string; response: unknown } | null>;
  /** Saves an attempt in its own transaction, right away. */
  insert(tenantId: string, ctx: LlmCallContext, attempt: AttemptRecord): Promise<{ id: string }>;
}

export interface BudgetPort {
  reserve(tenantId: string, usd: number): Promise<{ day: string } | null>;
  settle(tenantId: string, day: string, reservedUsd: number, actualUsd: number): Promise<void>;
}

/** Fault injection for the crash-window tests (docs/architecture.md §10). */
export interface GatewayHooks {
  /** After the model answered, before the attempt is saved: a throw here loses the response. */
  afterResponse?: (info: { stage: LlmStage }) => void | Promise<void>;
  /** After the attempt is saved: a throw here leaves a reusable attempt behind. */
  afterAttemptSaved?: (info: { stage: LlmStage; attemptId: string }) => void | Promise<void>;
}

/** Shared provider backpressure (packages/db provider-state.ts). Absent: no cooldowns (tests, replay). */
export interface CooldownPort {
  state(provider: string, model: string): Promise<{ cooldownUntil: Date; consecutiveFailures: number } | null>;
  trip(provider: string, model: string, retryAfterMs: number | null, reason: string): Promise<void>;
  clear(provider: string, model: string): Promise<void>;
}

/** One model call as telemetry sees it (the worker logs it and counts it). */
export interface CallInfo {
  stage: LlmStage;
  provider: string;
  model: string;
  mode: LlmCallMode;
  /** A saved attempt was reused: no call was made. */
  reused: boolean;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number | null;
  stopReason: string | null;
  error: string | null;
}

export interface GatewayDeps {
  mode: LlmMode;
  transport: Transport;
  store: AttemptStore;
  budget: BudgetPort;
  findPrice: FindPrice;
  cooldown?: CooldownPort;
  /** Called once per call: reused, failed or answered. */
  onCall?: (info: CallInfo) => void;
  now?: () => Date;
  hooks?: GatewayHooks;
}

/** A call meeting a cooldown that ends this soon waits it out; a longer one gives the job back. */
export const COOLDOWN_WAIT_MS = 20_000;

export interface CallResult {
  attemptId: string;
  output: unknown;
  reused: boolean;
}

const describe = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000);

/**
 * Every model call goes through here (invariant 4):
 * 1. Reuse a saved successful attempt for (context, stage) if there is one.
 * 2. Otherwise wait out (briefly) or give back a provider cooldown, then reserve the worst case
 *    against the daily budget (live and record modes only).
 * 3. Call, then save the attempt with its response in its own transaction immediately.
 * 4. Settle the budget to the actual cost, and only then interpret the response.
 * A crash between 3's call and its save loses the response, and the retry pays again: repeat calls
 * are possible, but saved responses are always reused. Never call this inside a transaction.
 */
export function createLlmGateway(deps: GatewayDeps) {
  const now = deps.now ?? (() => new Date());
  async function call(input: {
    tenantId: string;
    ctx: LlmCallContext;
    request: LlmRequest;
    /** The job's signal: aborts the call when the job expires or the worker shuts down. */
    signal?: AbortSignal;
  }): Promise<CallResult> {
    const { tenantId, ctx, request, signal } = input;
    const existing = await deps.store.findReusable(tenantId, ctx, request.stage);
    const report = (info: Omit<CallInfo, "stage" | "model">) =>
      deps.onCall?.({ stage: request.stage, model: request.model, ...info });
    if (existing) {
      report({
        provider: toWireRequest(request).provider,
        mode: deps.mode === "replay" ? "replay" : "live",
        reused: true,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: null,
        error: null,
      });
      return {
        attemptId: existing.id,
        output: readOutput(normalizeResponse(request.model, existing.response), request.maxTokens),
        reused: true,
      };
    }

    const wire = toWireRequest(request);
    const hash = requestHash(wire);
    const provider = wire.provider;
    // Backpressure: replay never calls a provider, so only live calls wait for a busy one.
    const cooldown = deps.mode === "replay" ? undefined : deps.cooldown;
    const state = await cooldown?.state(provider, request.model);
    if (state) {
      const wait = state.cooldownUntil.getTime() - now().getTime();
      if (wait > COOLDOWN_WAIT_MS) throw new ProviderCoolingDownError(request.model, state.cooldownUntil);
      if (wait > 0) await sleep(wait, undefined, { signal });
    }
    let reservation: { day: string; usd: number } | null = null;
    if (deps.mode !== "replay") {
      const price = await deps.findPrice(request.model, estimatePromptTokens(request));
      if (!price) throw new PipelineError("llm_bad_request", `no price configured for ${request.model}`);
      const usd = estimateWorstCaseUsd(request, price);
      const reserved = await deps.budget.reserve(tenantId, usd);
      if (!reserved) throw new BudgetExhaustedError(tenantId);
      reservation = { day: reserved.day, usd };
    }

    const base = { stage: request.stage, model: request.model, effort: request.effort, requestHash: hash };
    let sent: Awaited<ReturnType<Transport["send"]>>;
    try {
      sent = await deps.transport.send(wire, {
        hash,
        stage: request.stage,
        signal,
        timeoutMs: llmTimeoutMs(request.stage, request.maxTokens),
      });
    } catch (err) {
      if (reservation) await deps.budget.settle(tenantId, reservation.day, reservation.usd, 0);
      if (err instanceof ProviderBusyError) {
        await cooldown?.trip(provider, request.model, err.retryAfterMs, `${err.status}`);
      }
      // A call that reached the API but failed is still an attempt (replay misses never call anything).
      if (deps.mode !== "replay") {
        await deps.store.insert(tenantId, ctx, {
          ...base,
          mode: "live",
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsd: 0,
          priceId: null,
          latencyMs: null,
          stopReason: null,
          servedByFallback: false,
          requestId: null,
          response: null,
          error: describe(err),
        });
      }
      report({
        provider,
        mode: deps.mode === "replay" ? "replay" : "live",
        reused: false,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        costUsd: 0,
        stopReason: null,
        error: describe(err),
      });
      throw err;
    }

    // The provider answered: a model that had been cooling down is healthy again.
    if (state && cooldown) await cooldown.clear(provider, request.model);
    await deps.hooks?.afterResponse?.({ stage: request.stage });
    const response: NormalizedResponse = normalizeResponse(request.model, sent.response);
    let outputError: unknown = null;
    let output: unknown = null;
    try {
      output = readOutput(response, request.maxTokens);
    } catch (err) {
      outputError = err;
    }
    const { costUsd, priceId } = await responseCostUsd(response, request.model, deps.findPrice);
    const { usage } = response;
    const attempt = await deps.store.insert(tenantId, ctx, {
      ...base,
      mode: sent.mode,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheCreationInputTokens: usage.cacheWrite5m + usage.cacheWrite1h,
      cacheReadInputTokens: usage.cacheRead,
      costUsd,
      priceId,
      latencyMs: sent.latencyMs,
      stopReason: response.stopReason,
      servedByFallback: response.servedByFallback,
      requestId: sent.requestId,
      response: sent.response,
      error: outputError ? describe(outputError) : null,
    });
    if (reservation) await deps.budget.settle(tenantId, reservation.day, reservation.usd, costUsd ?? reservation.usd);
    report({
      provider,
      mode: sent.mode,
      reused: false,
      latencyMs: sent.latencyMs,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      costUsd,
      stopReason: response.stopReason,
      error: outputError ? describe(outputError) : null,
    });
    await deps.hooks?.afterAttemptSaved?.({ stage: request.stage, attemptId: attempt.id });
    if (outputError) throw outputError;
    return { attemptId: attempt.id, output, reused: false };
  }

  return { call };
}

export type LlmGateway = ReturnType<typeof createLlmGateway>;
