// The worker's telemetry (docs/operations.md): a JSON log line per job and per model call, the
// Prometheus metrics, a heartbeat row, and a small HTTP server (WORKER_HTTP_PORT) with /health,
// /ready and /metrics for probes and scrapers. Every job runs under its trace id (packages/telemetry),
// so the jobs it enqueues and the lines it logs carry the id of the request that started the work.
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { APP_VERSION, PROVIDERS } from "@ai-triage/core";
import {
  activeCooldowns,
  createDb,
  type Pool,
  pingDb,
  pruneHeartbeats,
  recordHeartbeat,
  removeHeartbeat,
} from "@ai-triage/db";
import { type CallInfo, providerKeyEnv, readRecorded } from "@ai-triage/llm";
import { createLogger, logLevelFromEnv, METRICS_CONTENT_TYPE, Registry, runWithTrace } from "@ai-triage/telemetry";

export const log = createLogger({ service: "worker", level: logLevelFromEnv() });

export const registry = new Registry();
const jobs = registry.counter("triage_jobs_total", "Jobs handled, by queue and outcome (ok, error).");
const jobSeconds = registry.histogram("triage_job_duration_seconds", "Time a handler spent on one job.");
const llmCalls = registry.counter(
  "triage_llm_calls_total",
  "Model calls, by provider, model, stage, mode and outcome (ok, error, reused).",
);
const llmSeconds = registry.histogram("triage_llm_call_seconds", "Model call latency (live and recorded).");
const llmTokens = registry.counter("triage_llm_tokens_total", "Tokens by model and kind (input, output, cache_read).");
const llmCost = registry.counter("triage_llm_cost_usd_total", "Cost of model calls by model and mode.");
const queueJobs = registry.gauge("triage_queue_jobs", "Jobs per queue and state (created, retry, active).");
const queueOldest = registry.gauge("triage_queue_oldest_seconds", "Age of the oldest waiting job per queue.");
const pool_ = registry.gauge("triage_db_pool_connections", "The app pool: total, idle, waiting.");
const cooldowns = registry.gauge("triage_provider_cooldown", "1 while a provider model is cooling down.");
registry.gauge("triage_worker_info", "This worker's version and LLM mode.");

interface JobLike {
  id: string;
  data: unknown;
}

/**
 * Wraps a pg-boss handler (batch size 1): runs the job under its trace, then logs and counts the
 * outcome. Errors are rethrown, so pg-boss still retries and dead-letters them.
 */
export function observed<J extends JobLike>(queue: string, handler: (job: J) => Promise<void>) {
  return async ([job]: J[]) => {
    if (!job) return;
    const data = (job.data ?? {}) as { traceId?: unknown; tenantId?: unknown; documentId?: unknown; runId?: unknown };
    const trace = typeof data.traceId === "string" ? data.traceId : job.id;
    const fields = { queue, job: job.id, tenant: data.tenantId, document: data.documentId, run: data.runId };
    const started = performance.now();
    await runWithTrace(trace, async () => {
      try {
        await handler(job);
        const ms = Math.round(performance.now() - started);
        jobs.inc({ queue, outcome: "ok" });
        jobSeconds.observe({ queue }, ms / 1000);
        log.info("job done", { ...fields, ms });
      } catch (err) {
        const ms = Math.round(performance.now() - started);
        jobs.inc({ queue, outcome: "error" });
        jobSeconds.observe({ queue }, ms / 1000);
        log.warn("job failed, pg-boss retries it", { ...fields, ms, err });
        throw err;
      }
    });
  };
}

const ocrPages = registry.counter("triage_ocr_pages_total", "Pages sent to OCR, by outcome (ok, failed).");
const ocrSeconds = registry.histogram("triage_ocr_page_seconds", "Time OCR took for one page.");

/** One OCR'd page: the metrics (the parse stage logs the document's outcome). */
export function recordOcrPage(ok: boolean, ms: number): void {
  ocrPages.inc({ outcome: ok ? "ok" : "failed" });
  if (ok) ocrSeconds.observe({}, ms / 1000);
}

/** The gateway's per-call hook: one log line and the model metrics. */
export function recordLlmCall(info: CallInfo): void {
  const outcome = info.reused ? "reused" : info.error ? "error" : "ok";
  llmCalls.inc({ provider: info.provider, model: info.model, stage: info.stage, mode: info.mode, outcome });
  if (info.reused) return;
  if (info.latencyMs !== null)
    llmSeconds.observe({ provider: info.provider, stage: info.stage }, info.latencyMs / 1000);
  llmTokens.inc({ model: info.model, kind: "input" }, info.inputTokens);
  llmTokens.inc({ model: info.model, kind: "output" }, info.outputTokens);
  llmTokens.inc({ model: info.model, kind: "cache_read" }, info.cacheReadTokens);
  if (info.costUsd) llmCost.inc({ model: info.model, mode: info.mode }, info.costUsd);
  const line = {
    provider: info.provider,
    model: info.model,
    stage: info.stage,
    mode: info.mode,
    tokens: { input: info.inputTokens, output: info.outputTokens, cacheRead: info.cacheReadTokens },
    costUsd: info.costUsd,
    ms: info.latencyMs,
    stopReason: info.stopReason,
    error: info.error ?? undefined,
  };
  if (info.error) log.warn("model call failed", line);
  else log.info("model call", line);
}

/** What waits in each queue, sampled from pg-boss (every worker samples; scrapers take the max). */
export async function sampleQueues(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string; state: string; n: number; oldest: number | null }>(`
    select name, state::text as state, count(*)::int as n,
           extract(epoch from now() - min(created_on) filter (where state in ('created', 'retry'))) as oldest
    from pgboss.job where state in ('created', 'retry', 'active') group by name, state`);
  queueJobs.replace(rows.map((r) => ({ labels: { queue: r.name, state: r.state }, value: r.n })));
  const oldest = new Map<string, number>();
  for (const r of rows) if (r.oldest !== null) oldest.set(r.name, Math.max(oldest.get(r.name) ?? 0, Number(r.oldest)));
  queueOldest.replace([...oldest].map(([queue, value]) => ({ labels: { queue }, value: Math.round(value) })));
  pool_.replace([
    { labels: { state: "total" }, value: pool.totalCount },
    { labels: { state: "idle" }, value: pool.idleCount },
    { labels: { state: "waiting" }, value: pool.waitingCount },
  ]);
  const cooling = await activeCooldowns(createDb(pool), new Date());
  cooldowns.replace(cooling.map((c) => ({ labels: { provider: c.provider, model: c.model }, value: 1 })));
}

/** What this worker can call, for onboarding's "can the active config run?" (core modelBlocker). */
export function workerCapabilities(env: NodeJS.ProcessEnv, cassetteDir: string) {
  const providers = PROVIDERS.filter((p) => {
    if (p === "sim") return false;
    if (p === "compat") return Boolean(env.OPENAI_COMPAT_BASE_URL);
    return Boolean(env[providerKeyEnv(p)]);
  });
  const recorded = Object.entries(readRecorded(cassetteDir)).map(([model, set]) => ({
    model,
    effort: set.effort ?? "low",
  }));
  return { providers, simulator: Boolean(env.LLM_SIMULATOR_URL), recorded, ocr: Boolean(env.OCR_URL) };
}

/**
 * Starts the heartbeat (every 15 s, also pruning rows a day stale), the queue sampler and the HTTP
 * server. Returns a stop function for shutdown, which also removes this worker's heartbeat.
 */
export async function startObservability(input: {
  pool: Pool;
  llmMode: string;
  port: number;
  cassetteDir: string;
}): Promise<() => Promise<void>> {
  const db = createDb(input.pool);
  const worker = {
    workerId: `${hostname()}:${process.pid}:${Date.now().toString(36)}`,
    hostname: hostname(),
    version: APP_VERSION,
    llmMode: input.llmMode,
    capabilities: workerCapabilities(process.env, input.cassetteDir),
    startedAt: new Date(),
  };
  registry.gauge("triage_worker_info", "").set({ version: APP_VERSION, llm_mode: input.llmMode }, 1);
  let lastBeat = 0;
  // The heartbeat says the worker is alive; the sample is only metrics, so it can't fail the beat.
  const beat = async () => {
    try {
      await recordHeartbeat(db, worker, new Date());
      lastBeat = Date.now();
    } catch (err) {
      log.warn("heartbeat failed", { err });
    }
    await sampleQueues(input.pool).catch((err) => log.warn("queue sample failed", { err }));
  };
  await beat();
  await pruneHeartbeats(db, new Date(Date.now() - 24 * 3600_000)).catch(() => {});
  const timer = setInterval(beat, 15_000);
  timer.unref();

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/health") {
      // Alive while the heartbeat loop is: a wedged event loop or a lost database shows here.
      const fresh = Date.now() - lastBeat < 60_000;
      res.writeHead(fresh ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: fresh ? "ok" : "stale", version: APP_VERSION, worker: worker.workerId }));
      return;
    }
    if (path === "/ready") {
      const up = await pingDb(db);
      res
        .writeHead(up ? 200 : 503, { "content-type": "application/json" })
        .end(JSON.stringify({ db: up ? "up" : "down" }));
      return;
    }
    if (path === "/metrics") {
      res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE }).end(registry.render());
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(input.port, resolve));
  log.info("worker http server listening", { port: input.port, paths: ["/health", "/ready", "/metrics"] });

  return async () => {
    clearInterval(timer);
    server.close();
    await removeHeartbeat(db, worker.workerId).catch(() => {});
  };
}
