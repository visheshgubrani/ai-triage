import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildPipelineConfig,
  clearCooldown,
  createBoss,
  createDb,
  createPool,
  getDocumentDetail,
  type PgBoss,
  withTenantTx,
} from "@ai-triage/db";
import { newTenant, testDbUrls } from "@ai-triage/db/testing";
import { ingestFile } from "@ai-triage/ingest";
import { createTransport } from "@ai-triage/llm";
import { DEFAULT_SIMULATOR_OPTIONS, type SimulatorOptions, simulate } from "@ai-triage/llm/testing";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerConfig } from "../config";
import { createDbLlmGateway } from "../llm";
import type { PipelineDeps } from "./deps";
import { drainTenantJobs } from "./drain";

// The pipeline end to end on the simulator (`sim:` models), in a worker whose LLM_MODE is replay:
// simulated calls still reach the simulator, are stored as `simulated`, cost nothing, and a 429
// storm turns into a shared cooldown, then provider_unavailable.

const { appUrl } = testDbUrls();
const pool = createPool(appUrl);
const storage = createStorage(storageConfigFromEnv());
let boss: PgBoss;
let server: Server;
let options: SimulatorOptions = { ...DEFAULT_SIMULATOR_OPTIONS, latencyMs: 0, jitterMs: 0 };

beforeAll(async () => {
  boss = createBoss(appUrl, { supervise: false, schedule: false });
  await boss.start();
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const answer = simulate(JSON.parse(Buffer.concat(chunks).toString("utf8")), options);
    res
      .writeHead(answer.status, { "content-type": "application/json", ...answer.headers })
      .end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.LLM_SIMULATOR_URL = `http://localhost:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  delete process.env.LLM_SIMULATOR_URL;
  server.close();
  await clearCooldown(createDb(pool), "sim", "sim:simulated");
  await boss.stop({ graceful: false });
  await pool.end();
});

const INVOICE = `Invoice number: INV-${randomUUID().slice(0, 6)}
Invoice date: 2026-10-01
Vendor name: Northwind Supplies
Currency: EUR
Subtotal: 100.00
Tax: 20.00
Total: 120.00
Please pay this invoice by 2026-10-31.`;

async function setup() {
  const tenantId = await newTenant(pool);
  await withTenantTx(pool, tenantId, (tx) =>
    buildPipelineConfig(tx, {
      classify: { model: "sim:simulated", effort: "none" },
      extract: { model: "sim:simulated", effort: "none" },
    }),
  );
  const deps: PipelineDeps = {
    pool,
    boss,
    storage,
    llm: createDbLlmGateway({ pool, mode: "replay", transport: createTransport("replay", workerConfig().cassetteDir) }),
    limits: { maxPdfPages: 100 },
    auditDraw: () => 0.5,
    now: () => new Date(),
  };
  const ingest = async (text: string) =>
    (
      await ingestFile(
        { pool, boss, storage },
        tenantId,
        { bytes: new TextEncoder().encode(text), filename: "invoice.txt", mime: "text/plain", source: "api" },
        { maxFileBytes: 2 ** 20 },
      )
    ).documentId;
  const rows = <T>(sql: string) =>
    withTenantTx(pool, tenantId, async (tx) => (await tx.queueDb.executeSql(sql, [])).rows as T[]);
  return { tenantId, deps, ingest, rows, drain: () => drainTenantJobs(deps, tenantId) };
}

describe("simulated models", () => {
  it("run the pipeline in a replay-mode worker, stored as simulated calls that cost nothing", async () => {
    const t = await setup();
    const documentId = await t.ingest(INVOICE);
    await t.drain();
    const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
    expect(detail?.document.processingStatus).toBe("done");
    expect(detail?.classification?.category).toBe("invoice");
    expect(detail?.extraction?.fields).toMatchObject({ vendor_name: "Northwind Supplies", total: 120 });
    const calls = await t.rows<{ mode: string; cost_usd: string }>("select mode, cost_usd from llm_calls");
    expect(calls.map((c) => c.mode)).toEqual(["simulated", "simulated"]);
    expect(calls.every((c) => Number(c.cost_usd) === 0)).toBe(true);
  });

  it("turn a 429 storm into one shared cooldown, then provider_unavailable, calling no more than once", async () => {
    const t = await setup();
    options = { ...options, rate429: 1, retryAfterSeconds: 600 };
    try {
      const documentId = await t.ingest(INVOICE);
      await t.drain();
      const detail = await withTenantTx(pool, t.tenantId, (tx) => getDocumentDetail(tx, documentId));
      expect(detail?.document.processingStatus).toBe("failed");
      expect(detail?.run?.error).toMatch(/^provider_unavailable/);
      // The first attempt reached the simulator; the retries found the cooldown and called nothing.
      const calls = await t.rows<{ error: string }>("select error from llm_calls");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.error).toMatch(/ProviderBusyError/);
    } finally {
      options = { ...options, rate429: 0 };
      await clearCooldown(createDb(pool), "sim", "sim:simulated");
    }
  });
});
