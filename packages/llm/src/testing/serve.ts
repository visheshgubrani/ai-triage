import { createServer } from "node:http";
import { DEFAULT_SIMULATOR_OPTIONS, type SimulatorOptions, simulate } from "./simulator";

// `pnpm llm-sim`: the simulator over HTTP (docs/llm.md). Point the app at it with
// LLM_SIMULATOR_URL=http://localhost:9050/v1 and use the `sim:simulated` model. Knobs come from
// SIM_* environment variables at start, and from POST /sim/config during a run:
//   curl -d '{"rate429":0.5}' http://localhost:9050/sim/config

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== undefined && process.env[name] !== "" ? value : fallback;
};

const port = num("LLM_SIM_PORT", 9050);
let options: SimulatorOptions = {
  ...DEFAULT_SIMULATOR_OPTIONS,
  latencyMs: num("SIM_LATENCY_MS", DEFAULT_SIMULATOR_OPTIONS.latencyMs),
  jitterMs: num("SIM_JITTER_MS", DEFAULT_SIMULATOR_OPTIONS.jitterMs),
  rate429: num("SIM_RATE_429", 0),
  rate500: num("SIM_RATE_500", 0),
};
const stats = { calls: 0, byStatus: {} as Record<string, number> };

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

  if (req.method === "GET" && path === "/health") return json(200, { status: "ok" });
  if (req.method === "GET" && path === "/sim/stats") return json(200, { ...stats, options });
  if (req.method === "POST" && path === "/sim/config") {
    try {
      options = { ...options, ...(JSON.parse(raw || "{}") as Partial<SimulatorOptions>) };
      return json(200, options);
    } catch {
      return json(400, { error: "invalid JSON" });
    }
  }
  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: { message: "invalid JSON body" } });
    }
    const answer = simulate(body, options);
    stats.calls++;
    stats.byStatus[answer.status] = (stats.byStatus[answer.status] ?? 0) + 1;
    await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    if (res.destroyed) return;
    return json(answer.status, answer.body, answer.headers);
  }
  json(404, { error: "not found" });
});

server.listen(port, () => {
  console.log(`LLM simulator on http://localhost:${port}/v1 (latency ${options.latencyMs}±${options.jitterMs} ms)`);
});
