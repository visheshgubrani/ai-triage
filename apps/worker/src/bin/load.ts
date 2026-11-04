import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  buildPipelineConfig,
  createApiKey,
  createPool,
  createTenant,
  keyRingFromEnv,
  setWebhook,
  withTenantTx,
} from "@ai-triage/db";
import { type VarietyMail, varietyMail } from "@ai-triage/fixtures/variety";

// `pnpm load`: a load and chaos test against a running stack (docs/reliability.md). It creates load
// tenants on the simulator (`sim:simulated`, automation on for invoices and support requests,
// webhooks to the catcher), sends generated mail of hundreds of kinds through the REST API with
// one noisy tenant, waits until every document is done, and reports throughput, end-to-end
// latency per tenant (the fairness ratio), failures by reason and the invariants that must hold:
// no stalled runs, at most one canonical attempt per stage, one action per approved document, and
// every action delivered. Chaos flags break things mid-run; the invariants must still hold.
//
//   pnpm load --docs 2000 --tenants 5 --skew 0.8
//   pnpm load --docs 500 --sim-storm 60
//   pnpm load --docs 500 --chaos "docker compose restart worker" --chaos-every 45

const { values: args } = parseArgs({
  options: {
    docs: { type: "string", default: "300" },
    tenants: { type: "string", default: "3" },
    skew: { type: "string", default: "0.6" },
    concurrency: { type: "string", default: "16" },
    seed: { type: "string", default: String(Date.now() % 100_000) },
    api: { type: "string", default: process.env.TRIAGE_API_URL ?? "http://localhost:8787" },
    "sim-url": { type: "string", default: "http://localhost:9050" },
    "sim-storm": { type: "string" },
    chaos: { type: "string" },
    "chaos-every": { type: "string", default: "45" },
    "timeout-min": { type: "string", default: "30" },
    "webhook-url": { type: "string", default: process.env.DEMO_WEBHOOK_URL ?? "http://localhost:9030/hooks/load" },
    out: { type: "string" },
  },
});

const docs = Number(args.docs);
const tenantCount = Math.max(1, Number(args.tenants));
const skew = Math.min(1, Math.max(0, Number(args.skew)));
const seed = Number(args.seed);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");
const pool = createPool(databaseUrl);
const keys = keyRingFromEnv(process.env);
const run = randomUUID().slice(0, 6);
const log = (msg: string) => console.log(`[load ${run}] ${msg}`);

interface LoadTenant {
  id: string;
  slug: string;
  key: string;
}

async function createLoadTenant(i: number): Promise<LoadTenant> {
  const slug = `load-${run}-${i}`;
  const { id } = await createTenant(pool, { name: `Load ${run} #${i}`, slug });
  const key = await withTenantTx(pool, id, async (tx) => {
    await buildPipelineConfig(tx, {
      classify: { model: "sim:simulated", effort: "none" },
      extract: { model: "sim:simulated", effort: "none" },
      categories: {
        invoice: { automation: "auto_when_confident", auditRate: 0.1 },
        support_request: { automation: "auto_when_confident", auditRate: 0.1 },
        contract: { automation: "review_all" },
      },
    });
    await tx.queueDb.executeSql("update tenant_settings set daily_llm_cap_usd = 1000", []);
    await setWebhook(tx, keys, { url: args["webhook-url"] ?? null, secret: `whsec_load_${run}` });
    return (await createApiKey(tx, { name: `load ${run}` })).key;
  });
  return { id, slug, key };
}

/** The tenant of document i: the noisy tenant (0) takes `skew` of them, the rest share the others evenly. */
const tenantOf = (i: number, tenants: LoadTenant[]) =>
  tenants.length === 1 || (i * 0.618034) % 1 < skew ? tenants[0]! : tenants[1 + (i % (tenants.length - 1))]!;

/** Sends one message, waiting out the API's per-key rate limit (429 + Retry-After) like a real client. */
async function send(
  tenant: LoadTenant,
  mail: VarietyMail,
): Promise<{ status: number; duplicate: boolean; waits: number }> {
  let waits = 0;
  for (;;) {
    const form = new FormData();
    form.set("file", new File([mail.eml], "mail.eml", { type: "message/rfc822" }));
    const res = await fetch(`${args.api}/api/v1/documents`, {
      method: "POST",
      headers: { authorization: `Bearer ${tenant.key}` },
      body: form,
    });
    if (res.status === 429 && waits < 30) {
      waits++;
      const seconds = Number(res.headers.get("retry-after")) || 5;
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 60) * 1000));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as { duplicate?: boolean };
    return { status: res.status, duplicate: body.duplicate === true, waits };
  }
}

const percentile = (sorted: number[], p: number) =>
  sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0);

/** A tenant's rows. Retried for a while: chaos runs restart Postgres under this tool too. */
async function tenantRows<T>(tenant: LoadTenant, sql: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenantTx(pool, tenant.id, async (tx) => (await tx.queueDb.executeSql(sql, [])).rows as T[]);
    } catch (err) {
      if (attempt >= 60) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function inFlight(tenants: LoadTenant[]): Promise<{ docs: number; deliveries: number }> {
  let docsLeft = 0;
  let deliveries = 0;
  for (const t of tenants) {
    const [row] = await tenantRows<{ docs: number; deliveries: number }>(
      t,
      `select (select count(*)::int from documents where processing_status in ('received','parsed','classified','extracted')) as docs,
              (select count(*)::int from actions where status = 'pending') as deliveries`,
    );
    docsLeft += row?.docs ?? 0;
    deliveries += row?.deliveries ?? 0;
  }
  return { docs: docsLeft, deliveries };
}

async function simConfig(options: Record<string, number>) {
  await fetch(`${args["sim-url"]}/sim/config`, { method: "POST", body: JSON.stringify(options) }).catch(() => {
    log(`could not reach the simulator at ${args["sim-url"]} to change its faults`);
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────

log(`${docs} documents across ${tenantCount} tenants (skew ${skew}, seed ${seed}) against ${args.api}`);
const tenants = await Promise.all(Array.from({ length: tenantCount }, (_, i) => createLoadTenant(i)));
const kinds = new Set<string>();
const sendStatus: Record<string, number> = {};
let duplicates = 0;
let rateLimited = 0;
const started = Date.now();

let chaosTimer: NodeJS.Timeout | undefined;
if (args.chaos) {
  const every = Number(args["chaos-every"]) * 1000;
  chaosTimer = setInterval(() => {
    log(`chaos: ${args.chaos}`);
    try {
      execSync(args.chaos as string, { stdio: "ignore" });
    } catch (err) {
      log(`chaos command failed: ${(err as Error).message}`);
    }
  }, every);
}

let next = 0;
let stormed = false;
async function sender() {
  while (next < docs) {
    const i = next++;
    if (args["sim-storm"] && !stormed && i >= docs / 3) {
      stormed = true;
      const seconds = Number(args["sim-storm"]);
      log(`sim storm: half of all model calls answer 429 for ${seconds} s`);
      await simConfig({ rate429: 0.5, retryAfterSeconds: 5 });
      setTimeout(() => void simConfig({ rate429: 0 }).then(() => log("sim storm over")), seconds * 1000);
    }
    const tenant = tenantOf(i, tenants);
    const mail = await varietyMail(seed, i, `inbox@${tenant.slug}.test`);
    kinds.add(mail.kind);
    try {
      const result = await send(tenant, mail);
      sendStatus[result.status] = (sendStatus[result.status] ?? 0) + 1;
      if (result.duplicate) duplicates++;
      rateLimited += result.waits;
    } catch {
      sendStatus.network = (sendStatus.network ?? 0) + 1;
    }
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, sender));
const sentAt = Date.now();
log(`sent in ${((sentAt - started) / 1000).toFixed(1)} s: ${JSON.stringify(sendStatus)}, ${kinds.size} kinds`);

const deadline = Date.now() + Number(args["timeout-min"]) * 60_000;
let left = await inFlight(tenants);
while ((left.docs > 0 || left.deliveries > 0) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  left = await inFlight(tenants);
  process.stdout.write(`\r[load ${run}] waiting: ${left.docs} documents, ${left.deliveries} deliveries   `);
}
process.stdout.write("\n");
if (chaosTimer) clearInterval(chaosTimer);
const finished = Date.now();

// ── Report ───────────────────────────────────────────────────────────────────────────────────

const latencies: number[] = [];
const perTenant: { tenant: string; docs: number; p50: number; p95: number }[] = [];
const failures: Record<string, number> = {};
const decisions: Record<string, number> = {};
const invariants = {
  stalledRuns: 0,
  duplicateCanonical: 0,
  duplicateActions: 0,
  undeliveredActions: 0,
  stuckDocuments: left.docs,
};
for (const t of tenants) {
  const rows = await tenantRows<{ ms: number; status: string; review: string; error: string | null }>(
    t,
    `select extract(epoch from coalesce(r.finished_at, d.updated_at) - d.created_at) * 1000 as ms,
            d.processing_status as status, d.review_status as review, r.error
     from documents d left join processing_runs r on r.id = d.current_run_id`,
  );
  const ms = rows.map((r) => Number(r.ms)).sort((a, b) => a - b);
  latencies.push(...ms);
  perTenant.push({ tenant: t.slug, docs: rows.length, p50: percentile(ms, 50), p95: percentile(ms, 95) });
  for (const r of rows) {
    if (r.error) failures[r.error.split(":")[0] ?? r.error] = (failures[r.error.split(":")[0] ?? r.error] ?? 0) + 1;
    decisions[r.status === "failed" ? "failed" : r.review === "not_required" ? "auto" : "review"] =
      (decisions[r.status === "failed" ? "failed" : r.review === "not_required" ? "auto" : "review"] ?? 0) + 1;
  }
  const [inv] = await tenantRows<{ stalled: number; canonical: number; actions: number; undelivered: number }>(
    t,
    `select (select count(*)::int from processing_runs where error like 'stalled%') as stalled,
            (select count(*)::int from (select processing_run_id, stage from llm_calls where canonical and processing_run_id is not null group by 1, 2 having count(*) > 1) x) as canonical,
            (select count(*)::int from (select document_id from actions group by 1 having count(*) > 1) y) as actions,
            (select count(*)::int from actions where status <> 'delivered') as undelivered`,
  );
  invariants.stalledRuns += inv?.stalled ?? 0;
  invariants.duplicateCanonical += inv?.canonical ?? 0;
  invariants.duplicateActions += inv?.actions ?? 0;
  invariants.undeliveredActions += inv?.undelivered ?? 0;
}
latencies.sort((a, b) => a - b);
const quiet = perTenant.slice(1);
const quietP95 = quiet.length ? Math.max(...quiet.map((t) => t.p95)) : 0;
const report = {
  run,
  seed,
  docs,
  tenants: tenantCount,
  skew,
  kinds: kinds.size,
  duplicatesDetected: duplicates,
  // Sends the API refused with 429 (its per-key limit) and the client retried after Retry-After.
  rateLimitedSends: rateLimited,
  sendStatus,
  seconds: { sending: (sentAt - started) / 1000, total: (finished - started) / 1000 },
  throughputPerMinute: Math.round((latencies.length / ((finished - started) / 1000)) * 60),
  latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), p99: percentile(latencies, 99) },
  perTenant,
  // Quiet tenants' p95 over the noisy tenant's: well under 1 means quiet tenants aren't stuck behind it.
  fairnessRatio: perTenant[0]?.p95 ? Math.round((quietP95 / perTenant[0].p95) * 100) / 100 : null,
  decisions,
  failures,
  invariants,
};

const ok =
  invariants.stalledRuns === 0 &&
  invariants.duplicateCanonical === 0 &&
  invariants.duplicateActions === 0 &&
  invariants.undeliveredActions === 0 &&
  invariants.stuckDocuments === 0;
console.log(JSON.stringify(report, null, 2));
console.log(
  `\n${ok ? "PASS" : "FAIL"}: ${latencies.length} documents, ${report.throughputPerMinute}/min, ` +
    `p50 ${Math.round(report.latencyMs.p50)} ms, p95 ${Math.round(report.latencyMs.p95)} ms, fairness ${report.fairnessRatio}`,
);
if (args.out) writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
await pool.end();
process.exit(ok ? 0 : 1);
