// Local webhook receiver for watching deliveries arrive (compose service `webhook-catcher`).
// Zero dependencies. It verifies X-Triage-Signature with WEBHOOK_SECRET, keeps the last 100
// requests in memory, and shows them at GET / (HTML) and GET /requests (JSON).
// `?status=NNN` on the webhook URL forces that response code, to exercise delivery failures.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const { PORT = "9030", WEBHOOK_SECRET: SECRET = "" } = process.env;
const TOLERANCE_SECONDS = 300;
const KEEP = 100;

/** @type {object[]} */
const received = [];

// Signature v2: HMAC-SHA256 of "<t>.<Idempotency-Key>.<raw body>"; one v2 per secret during a rotation.
function verify(header, idempotencyKey, body, now) {
  if (!SECRET) return "no secret configured";
  if (!header) return "missing";
  const pairs = header.split(",").map((kv) => kv.split("=", 2));
  const t = Number(pairs.find(([k]) => k === "t")?.[1]);
  const signatures = pairs.filter(([k, v]) => k === "v2" && v).map(([, v]) => Buffer.from(v, "hex"));
  if (!Number.isFinite(t) || signatures.length === 0 || !idempotencyKey) return "malformed";
  if (Math.abs(now / 1000 - t) > TOLERANCE_SECONDS) return "timestamp outside tolerance";
  const expected = createHmac("sha256", SECRET).update(`${t}.${idempotencyKey}.${body}`).digest();
  return signatures.some((given) => given.length === expected.length && timingSafeEqual(given, expected))
    ? "valid"
    : "invalid";
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page() {
  const rows = received
    .map(
      (r) => `<article>
  <header><b>${escapeHtml(r.receivedAt)}</b> ${escapeHtml(r.method)} ${escapeHtml(r.path)} → ${r.status}
  · signature <b class="${r.signature === "valid" ? "ok" : "bad"}">${escapeHtml(r.signature)}</b></header>
  <div>Idempotency-Key: <code>${escapeHtml(r.idempotencyKey ?? "(none)")}</code> · event: <code>${escapeHtml(r.event ?? "(none)")}</code></div>
  <pre>${escapeHtml(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2))}</pre>
</article>`,
    )
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Webhook catcher</title>
<meta http-equiv="refresh" content="5">
<style>body{font:14px system-ui;margin:2rem;max-width:60rem}article{border:1px solid #ccc;border-radius:6px;padding:.75rem;margin:.75rem 0}
pre{background:#f5f5f5;padding:.5rem;overflow:auto}.ok{color:#047857}.bad{color:#b91c1c}</style></head>
<body><h1>Webhook catcher</h1><p>${received.length} request(s), newest first. Refreshes every 5 s.</p>${rows || "<p>Nothing yet.</p>"}</body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://catcher");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page());
    return;
  }
  if (req.method === "GET" && url.pathname === "/requests") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(received));
    return;
  }
  if (req.method === "DELETE" && url.pathname === "/requests") {
    received.length = 0;
    res.writeHead(204).end();
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const forced = Number(url.searchParams.get("status"));
    const status = forced >= 200 && forced <= 599 ? forced : 200;
    let body = raw;
    try {
      body = JSON.parse(raw);
    } catch {}
    received.unshift({
      receivedAt: new Date().toISOString(),
      method: req.method,
      path: url.pathname + url.search,
      status,
      idempotencyKey: req.headers["idempotency-key"] ?? null,
      event: req.headers["x-triage-event"] ?? null,
      signature: verify(req.headers["x-triage-signature"], req.headers["idempotency-key"], raw, Date.now()),
      body,
    });
    received.length = Math.min(received.length, KEEP);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ received: status < 300 }));
  });
});

server.listen(Number(PORT), () =>
  console.log(`webhook catcher on :${PORT}${SECRET ? "" : " (no WEBHOOK_SECRET: signatures not checked)"}`),
);
