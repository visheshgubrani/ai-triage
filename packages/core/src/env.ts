// Every environment variable the app reads, in one place: who reads it, its default, whether it's a
// secret, and how to validate it. `.env.example` and docs/configuration.md are rendered from this
// list (`pnpm config:docs`, checked by env.test.ts), and a source scan fails on a variable that
// isn't listed here. Pure data and pure functions: callers pass the environment in.

/** Who reads a variable. `cli` covers migrations, seeds and the other bins; `compose` is interpolation only. */
export const ENV_PROCESSES = ["api", "worker", "web", "cli", "compose"] as const;
export type EnvProcess = (typeof ENV_PROCESSES)[number];

export type EnvKind = "string" | "url" | "int" | "number" | "bool" | "list" | "enum";

export interface EnvVar {
  name: string;
  /** Heading in `.env.example` and docs/configuration.md. */
  group: string;
  processes: readonly EnvProcess[];
  description: string;
  kind: EnvKind;
  /** For `enum`. */
  values?: readonly string[];
  /** What the code uses when the variable is unset or empty (documentation only). */
  default?: string;
  /** Written to `.env.example`. Absent: the line is commented out, so a copied file leaves it unset. */
  example?: string;
  secret?: boolean;
  /** Processes that refuse to start without it. */
  requiredBy?: readonly EnvProcess[];
}

const API_WORKER = ["api", "worker"] as const;
const SERVER = ["api", "worker", "cli"] as const;

export const ENV_VARS: readonly EnvVar[] = [
  // ── Instance ──
  {
    name: "TRIAGE_DEMO",
    group: "Instance",
    processes: [...SERVER, "compose"],
    kind: "bool",
    example: "true",
    description:
      "Local demo / development. With NODE_ENV=production the api and worker refuse the dev defaults below unless this is set (docs/security.md, production checklist). Never set it on a real instance.",
  },
  {
    name: "NODE_ENV",
    group: "Instance",
    processes: [...SERVER, "web"],
    kind: "enum",
    values: ["development", "production", "test"],
    description:
      "`production` turns on the startup safety checks. The Docker image sets it; leave it unset for development.",
  },
  // ── Postgres ──
  {
    name: "POSTGRES_PORT",
    group: "Postgres",
    processes: ["compose"],
    kind: "int",
    default: "5440",
    example: "5440",
    description: "Host port of the compose Postgres.",
  },
  {
    name: "DATABASE_OWNER_URL",
    group: "Postgres",
    processes: ["cli"],
    kind: "url",
    secret: true,
    example: "postgres://triage:triage@localhost:5440/triage",
    description: "The owner role: migrations, seeds and the admin CLIs only. Never give it to the api, worker or web.",
  },
  {
    name: "MIGRATIONS_DIR",
    group: "Postgres",
    processes: ["cli"],
    kind: "string",
    default: "packages/db/migrations (next to the source)",
    description: "Where `db:migrate` finds the SQL migrations. The Docker image sets it for its bundled CLI.",
  },
  {
    name: "DATABASE_URL",
    group: "Postgres",
    processes: SERVER,
    kind: "url",
    secret: true,
    requiredBy: API_WORKER,
    example: "postgres://triage_app:triage_app@localhost:5440/triage",
    description:
      "The app role, created by `pnpm db:migrate` and subject to row-level security. The worker needs a direct (non-pooled) connection: pg-boss uses LISTEN and advisory locks.",
  },
  {
    name: "DB_POOL_MAX",
    group: "Postgres",
    processes: API_WORKER,
    kind: "int",
    default: "10 (api); 4 + 2 × WORKER_LLM_CONCURRENCY + eval + mailbox concurrency (worker)",
    description:
      "Connections in the app's pool, per process (pg-boss keeps 10 more of its own). Raise it with the worker's concurrency; keep the total under Postgres's max_connections.",
  },
  // ── Storage ──
  {
    name: "S3_PORT",
    group: "Storage",
    processes: ["compose"],
    kind: "int",
    default: "9020",
    example: "9020",
    description: "Host port of the compose RustFS (S3 API).",
  },
  {
    name: "S3_CONSOLE_PORT",
    group: "Storage",
    processes: ["compose"],
    kind: "int",
    default: "9021",
    example: "9021",
    description: "Host port of the RustFS console.",
  },
  {
    name: "S3_ENDPOINT",
    group: "Storage",
    processes: SERVER,
    kind: "url",
    requiredBy: API_WORKER,
    example: "http://localhost:9020",
    description: "S3-compatible endpoint the server uses (AWS: https://s3.<region>.amazonaws.com).",
  },
  {
    name: "S3_REGION",
    group: "Storage",
    processes: SERVER,
    kind: "string",
    default: "us-east-1",
    example: "us-east-1",
    description: "Region used for request signing.",
  },
  {
    name: "S3_BUCKET",
    group: "Storage",
    processes: SERVER,
    kind: "string",
    requiredBy: API_WORKER,
    example: "triage",
    description: "Bucket for document sources. Keep it private; files are served through short-lived presigned URLs.",
  },
  {
    name: "S3_ACCESS_KEY_ID",
    group: "Storage",
    processes: SERVER,
    kind: "string",
    requiredBy: API_WORKER,
    example: "triage",
    description: "Storage access key.",
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    group: "Storage",
    processes: SERVER,
    kind: "string",
    secret: true,
    requiredBy: API_WORKER,
    example: "triage-secret",
    description: "Storage secret key. Production refuses the dev default.",
  },
  {
    name: "S3_PUBLIC_ENDPOINT",
    group: "Storage",
    processes: [...SERVER, "web"],
    kind: "url",
    default: "S3_ENDPOINT",
    example: "http://localhost:9020",
    description:
      "Host used in presigned URLs, which the browser must reach (differs from S3_ENDPOINT inside docker). Keep it on its own origin: user files never share the app's origin.",
  },
  // ── Limits ──
  {
    name: "MAX_FILE_MB",
    group: "Limits",
    processes: SERVER,
    kind: "number",
    default: "20",
    example: "20",
    description:
      "Largest accepted file. Inline PDFs are base64-encoded (4/3 larger) and a request may not exceed 32 MB.",
  },
  {
    name: "MAX_PDF_PAGES",
    group: "Limits",
    processes: ["worker"],
    kind: "int",
    default: "100",
    example: "100",
    description: "PDFs with more pages fail as too_many_pages.",
  },
  // ── Postmark ──
  {
    name: "POSTMARK_INBOUND_USER",
    group: "Postmark inbound",
    processes: ["api"],
    kind: "string",
    example: "postmark",
    description:
      "Basic-auth user in the Postmark inbound webhook URL (https://user:pass@host/api/webhooks/postmark). Unset with the password: the webhook is off.",
  },
  {
    name: "POSTMARK_INBOUND_PASSWORD",
    group: "Postmark inbound",
    processes: ["api"],
    kind: "string",
    secret: true,
    example: "dev-only-postmark-password",
    description: "Basic-auth password for the Postmark webhook. Production needs 16 or more characters.",
  },
  {
    name: "INBOUND_DOMAIN",
    group: "Postmark inbound",
    processes: ["api", "cli"],
    kind: "string",
    example: "",
    description:
      "Where generated (unguessable) inbound addresses live: a domain whose MX points at Postmark (`inbound.acme.com`), or a Postmark server's own inbound address (`abc123@inbound.postmarkapp.com`), which needs no DNS: tenants then get `abc123+t-…@inbound.postmarkapp.com`. Empty: new tenants get no address, and existing ones keep theirs.",
  },
  // ── API and web ──
  {
    name: "API_PORT",
    group: "API and web",
    processes: ["api", "compose"],
    kind: "int",
    default: "8787",
    example: "8787",
    description: "Port the api listens on.",
  },
  {
    name: "WEB_PORT",
    group: "API and web",
    processes: ["compose"],
    kind: "int",
    default: "3000",
    description: "Host port of the web app in the Docker demo.",
  },
  {
    name: "PUBLIC_URL",
    group: "API and web",
    processes: ["api", "cli"],
    kind: "url",
    default: "WEB_ORIGIN, else http://localhost:3000",
    example: "http://localhost:3000",
    description:
      "The one address people use: the web app, with the API under /api on the same origin (cookies, the Origin check, invite links, OAuth redirect URIs). An origin only, no path. Must be https in production.",
  },
  {
    name: "WEB_ORIGIN",
    group: "API and web",
    processes: ["api", "cli"],
    kind: "url",
    description: "Older name for PUBLIC_URL, still honored when PUBLIC_URL is unset.",
  },
  {
    name: "API_INTERNAL_URL",
    group: "API and web",
    processes: ["web"],
    kind: "url",
    default: "http://localhost:8787",
    description:
      "How the web server reaches the api, without /api (in compose: http://api:8787). Server components call it directly; `pnpm dev` also proxies the browser's /api through it.",
  },
  {
    name: "METRICS_TOKEN",
    group: "API and web",
    processes: ["api"],
    kind: "string",
    secret: true,
    description:
      "Turns on /api/metrics (Prometheus) for scrapers sending `Authorization: Bearer <token>`. Unset: the endpoint answers 404.",
  },
  {
    name: "NEXT_PUBLIC_API_URL",
    group: "API and web",
    processes: ["api"],
    kind: "url",
    description: "No longer used (the browser calls /api on the same origin). The api warns when it's set.",
  },
  {
    name: "TRUSTED_PROXIES",
    group: "API and web",
    processes: ["api"],
    kind: "list",
    example: "",
    description:
      "Proxies in front of the API (IPs or CIDRs, comma-separated): only their X-Forwarded-For is believed, for rate limits, audit and session IPs. Empty: the socket address is the client.",
  },
  {
    name: "RATE_LIMIT_SCALE",
    group: "API and web",
    processes: API_WORKER,
    kind: "number",
    default: "1",
    example: "1",
    description: "Multiplies every request limit (apps/api/src/rate-limit.ts), for a busy instance.",
  },
  {
    name: "REQUIRE_ADMIN_2FA",
    group: "API and web",
    processes: ["api"],
    kind: "bool",
    default: "true (false with TRIAGE_DEMO=true)",
    example: "",
    description: "Admin-only routes need the admin's TOTP 2FA. Defaults to on, except with TRIAGE_DEMO=true.",
  },
  // ── Secrets ──
  {
    name: "ENCRYPTION_KEY",
    group: "Secrets",
    processes: SERVER,
    kind: "string",
    secret: true,
    example: "",
    description:
      "Encrypts webhook signing secrets and mailbox tokens at rest: 32 random bytes, base64 (`openssl rand -base64 32`). Unset in development and the demo, a published dev key is used; production refuses to start without one.",
  },
  {
    name: "ENCRYPTION_KEYS",
    group: "Secrets",
    processes: SERVER,
    kind: "list",
    secret: true,
    description:
      "A key ring for rotation, newest first: `new:<base64>,old:<base64>`. Then run `pnpm secrets:rotate-key`. Takes precedence over ENCRYPTION_KEY.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    group: "Secrets",
    processes: ["api"],
    kind: "string",
    secret: true,
    requiredBy: ["api"],
    example: "dev-only-secret-change-me-0123456789abcdef",
    description: "Signs sessions. Dev-only value here; generate a real one with `openssl rand -base64 32`.",
  },
  {
    name: "BETTER_AUTH_URL",
    group: "Secrets",
    processes: ["api"],
    kind: "url",
    description:
      "No longer needed: auth runs at PUBLIC_URL/api/auth. A value on another origin is ignored with a warning.",
  },
  // ── Google ──
  {
    name: "GOOGLE_CLIENT_ID",
    group: "Google",
    processes: SERVER,
    kind: "string",
    example: "",
    description:
      "One OAuth client for Sign in with Google and Gmail mailbox sync (docs/google.md). Leave it and the secret empty to hide every Google feature. Redirect URIs to register: <PUBLIC_URL>/api/auth/callback/google and <PUBLIC_URL>/api/integrations/google/callback.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    group: "Google",
    processes: SERVER,
    kind: "string",
    secret: true,
    example: "",
    description: "The OAuth client's secret. Set both or neither.",
  },
  {
    name: "GOOGLE_OAUTH_URL",
    group: "Google",
    processes: SERVER,
    kind: "url",
    description:
      "Points Google's consent screen at the local fake (`pnpm fake-google`, e.g. http://localhost:9040) for the demo and e2e. Production refuses it unless TRIAGE_DEMO=true.",
  },
  {
    name: "GOOGLE_TOKEN_URL",
    group: "Google",
    processes: SERVER,
    kind: "url",
    default: "GOOGLE_OAUTH_URL",
    description: "The fake's token endpoint as the server reaches it, when that differs from the browser's address.",
  },
  {
    name: "GOOGLE_API_URL",
    group: "Google",
    processes: SERVER,
    kind: "url",
    description: "Points the Gmail API at the local fake. Production refuses it unless TRIAGE_DEMO=true.",
  },
  {
    name: "FAKE_GOOGLE_PORT",
    group: "Google",
    processes: ["cli"],
    kind: "int",
    default: "9040",
    description: "Port of `pnpm fake-google`.",
  },
  {
    name: "FAKE_GOOGLE_MAILBOX",
    group: "Google",
    processes: ["cli"],
    kind: "string",
    default: "ap@demo-workspace.test",
    description: "The address the fake Google's demo mailbox answers as.",
  },
  // ── Models ──
  {
    name: "LLM_MODE",
    group: "Models",
    processes: SERVER,
    kind: "enum",
    values: ["replay", "record", "live"],
    default: "replay",
    example: "replay",
    description:
      "replay (default: recorded responses, no key, no spend) | record (live calls, saved as cassettes) | live.",
  },
  {
    name: "DEFAULT_MODEL",
    group: "Models",
    processes: ["api", "cli"],
    kind: "string",
    default: "claude-opus-5-5",
    example: "",
    description:
      "The model (a MODEL_CATALOG ref) a new workspace's first pipeline config uses for both stages, at low effort where it has one. The installer sets it to match the provider key you gave. Admins change it later in Settings → Pipeline.",
  },
  {
    name: "ANTHROPIC_API_KEY",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "Needed only in record/live mode, and only when a config uses Claude.",
  },
  {
    name: "OPENAI_API_KEY",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "For `openai:` models.",
  },
  {
    name: "OPENAI_BASE_URL",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "url",
    default: "https://api.openai.com/v1",
    description: "Overrides the OpenAI endpoint (a proxy or gateway).",
  },
  {
    name: "DEEPSEEK_API_KEY",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "For `deepseek:` models.",
  },
  {
    name: "DEEPSEEK_BASE_URL",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "url",
    default: "https://api.deepseek.com",
    description: "Overrides the DeepSeek endpoint.",
  },
  {
    name: "OPENROUTER_API_KEY",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "For `openrouter:` models.",
  },
  {
    name: "OPENROUTER_BASE_URL",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "url",
    default: "https://openrouter.ai/api/v1",
    description: "Overrides the OpenRouter endpoint.",
  },
  {
    name: "OPENAI_COMPAT_BASE_URL",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "url",
    example: "",
    description: "Any OpenAI-compatible server for `compat:` models, e.g. Ollama at http://localhost:11434/v1.",
  },
  {
    name: "OPENAI_COMPAT_API_KEY",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "Key for the compat server, if it needs one.",
  },
  {
    name: "LLM_SIMULATOR_URL",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "url",
    description:
      "The simulator for `sim:` models (`pnpm llm-sim`, e.g. http://localhost:9050/v1): schema-valid fake answers at no cost, in any LLM_MODE. For load tests, integration tests and trying custom categories; never for real decisions.",
  },
  {
    name: "LLM_SIMULATOR_KEY",
    group: "Models",
    processes: ["worker"],
    kind: "string",
    description: "Sent to the simulator as its API key; it ignores it.",
  },
  {
    name: "LLM_SIM_PORT",
    group: "Models",
    processes: ["cli"],
    kind: "int",
    default: "9050",
    description:
      "Port of `pnpm llm-sim`. Its latency and fault rates come from SIM_LATENCY_MS, SIM_JITTER_MS, SIM_RATE_429 and SIM_RATE_500, or POST /sim/config.",
  },
  {
    name: "SIM_PORT",
    group: "Models",
    processes: ["compose"],
    kind: "int",
    default: "9050",
    description: "Host port of the Docker demo's simulator.",
  },
  {
    name: "CASSETTE_DIR",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    default: "fixtures/cassettes",
    example: "fixtures/cassettes",
    description: "Recorded responses (replay reads, record writes). Relative to the repo root.",
  },
  {
    name: "FIXTURES_DIR",
    group: "Models",
    processes: ["worker", "cli"],
    kind: "string",
    default: "fixtures",
    example: "fixtures",
    description: "The synthetic documents used by the seeds and the recorder.",
  },
  // ── Worker ──
  {
    name: "WORKER_LLM_CONCURRENCY",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "4",
    example: "4",
    description: "Concurrent jobs per LLM stage queue (classify and extract each), per worker process.",
  },
  {
    name: "WORKER_EVAL_CONCURRENCY",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "2",
    example: "2",
    description: "Eval items processed at once (each makes up to two model calls), on top of the pipeline stages.",
  },
  {
    name: "WORKER_MAILBOX_CONCURRENCY",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "4",
    example: "4",
    description: "Gmail messages downloaded at once.",
  },
  {
    name: "MAILBOX_SYNC_BATCH",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "200",
    example: "200",
    description: "New messages one sync of a mailbox takes; the rest follow a minute later.",
  },
  {
    name: "WORKER_TENANT_CONCURRENCY",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    description:
      "Fairness across tenants: at most this many of one tenant's jobs run at once per queue (pipeline stages, delivery, Gmail fetch), counted across every worker. Unset: no cap (one company). With several tenants, about half the cluster's slots per LLM queue (replicas × WORKER_LLM_CONCURRENCY).",
  },
  {
    name: "WORKER_TENANT_EVAL_CONCURRENCY",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    description: "The same cap for eval items, so one tenant's eval run can't take every eval slot.",
  },
  {
    name: "WORKER_HTTP_PORT",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "9100",
    description:
      "The worker's own HTTP server: /health (its heartbeat loop), /ready (database) and /metrics (Prometheus). Keep it off the public network.",
  },
  {
    name: "LOG_LEVEL",
    group: "Worker",
    processes: ["api", "worker"],
    kind: "enum",
    values: ["debug", "info", "warn", "error"],
    default: "info",
    description: "Logs are JSON lines (one per request, job and model call), or readable lines on a terminal.",
  },
  {
    name: "WORKER_SHUTDOWN_GRACE_MS",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "25000",
    description:
      "On SIGTERM, how long running jobs may finish before their model calls are aborted (they retry on another worker). Keep it under the container's stop grace period.",
  },
  {
    name: "RECONCILE_STALL_MINUTES",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "30",
    description:
      "Work unchanged this long is checked against the queue: a run, delivery or eval run with no job left is marked failed (Processing failed, Delivery failures), never silently re-run. At least 15.",
  },
  {
    name: "PARSE_TIMEOUT_MS",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "60000",
    description: "Files are parsed in a sandboxed thread; one that takes longer fails as parse_timeout.",
  },
  {
    name: "PARSE_MAX_MEMORY_MB",
    group: "Worker",
    processes: ["worker"],
    kind: "int",
    default: "512",
    description: "Heap limit of the parse thread. A file that needs more fails as parse_timeout.",
  },
  // ── OCR (optional) ──
  {
    name: "OCR_URL",
    group: "OCR (optional)",
    processes: ["worker", "cli"],
    kind: "url",
    example: "",
    description:
      "PaddleOCR-VL behind llama.cpp's server (OpenAI-compatible), such as http://ocr:8080/v1: scans and photos get text, so their quotes can be checked and text-only models can read them. `install.sh --ocr <backend>` sets it. Unset: off.",
  },
  {
    name: "OCR_TIMEOUT_MS",
    group: "OCR (optional)",
    processes: ["worker"],
    kind: "int",
    default: "120000",
    description: "Longest one page may take. A document's pages share a 10-minute budget (OCR_BUDGET_MS in core).",
  },
  {
    name: "OCR_MAX_PAGES",
    group: "OCR (optional)",
    processes: ["worker"],
    kind: "int",
    default: "20",
    description: "Pages of one document OCR reads at most; the rest stay unverifiable (sent to review).",
  },
  // ── Webhooks ──
  {
    name: "WEBHOOK_ALLOWED_HOSTS",
    group: "Webhooks",
    processes: API_WORKER,
    kind: "list",
    example: "",
    description:
      "URLs must be public https hosts (SSRF guard). Receivers on a private network go here as hostnames or CIDRs (these may also use http). TRIAGE_DEMO adds localhost and the catcher.",
  },
  {
    name: "WEBHOOK_TIMEOUT_MS",
    group: "Webhooks",
    processes: ["worker"],
    kind: "int",
    default: "10000",
    example: "10000",
    description: "How long a delivery waits for the receiver.",
  },
  {
    name: "CATCHER_PORT",
    group: "Webhooks",
    processes: ["compose"],
    kind: "int",
    default: "9030",
    example: "9030",
    description: "Host port of the local webhook catcher (docker compose).",
  },
  {
    name: "DEMO_WEBHOOK_URL",
    group: "Webhooks",
    processes: ["cli"],
    kind: "url",
    example: "http://localhost:9030/hooks/demo",
    description: "The demo tenant's webhook, which the seed points at the catcher.",
  },
  {
    name: "DEMO_WEBHOOK_SECRET",
    group: "Webhooks",
    processes: ["cli"],
    kind: "string",
    secret: true,
    example: "whsec_dev_only_demo_webhook_secret",
    description: "The demo tenant's signing secret (the catcher verifies with it).",
  },
  // ── Install (deploy/compose.yaml) ──
  // Written by `cli configure` into an installation's .env (docs/install.md); compose interpolation only.
  ...(
    [
      [
        "TRIAGE_VERSION",
        "Image tag to run (`ghcr.io/visheshgubrani/ai-triage:<version>`). `./triage upgrade --version` changes it.",
        "latest",
      ],
      ["TRIAGE_IMAGE", "Image repository, for running your own build.", "ghcr.io/visheshgubrani/ai-triage"],
      ["APP_HOST", "The installation's hostname: `localhost`, or the server's DNS name.", undefined],
      [
        "APP_PORT",
        "A local install's port (`install.sh --port`); stored files are on the next one (FILES_PORT).",
        "3000",
      ],
      ["FILES_PORT", "A local install's port for stored files: APP_PORT + 1.", "3001"],
      [
        "APP_SITE",
        "Caddy's address for the app: the hostname (HTTPS, automatic certificates), or `http://:3000` locally.",
        undefined,
      ],
      [
        "FILES_SITE",
        "Caddy's address for stored files, a separate origin: the hostname on :8443, or `http://:3001` locally.",
        undefined,
      ],
      ["ACME_EMAIL", "Let's Encrypt account email (certificate expiry notices).", undefined],
      ["POSTGRES_PASSWORD", "Bundled Postgres: the owner's password (DATABASE_OWNER_URL uses it).", undefined],
      [
        "DATABASE_APP_PASSWORD",
        "Bundled Postgres: the app role's password (DATABASE_URL uses it; migrate sets it).",
        undefined,
      ],
      ["OCR_BACKEND", "Optional OCR service for scans and photos: nvidia | vulkan | rocm | cpu | off.", "off"],
    ] as const
  ).map(
    ([name, description, def]): EnvVar => ({
      name,
      group: "Install (deploy/compose.yaml)",
      processes: ["compose"],
      kind: "string",
      description,
      ...(def ? { default: def } : {}),
      ...(name.includes("PASSWORD") ? { secret: true } : {}),
    }),
  ),
  // ── CLI ──
  {
    name: "TRIAGE_API_URL",
    group: "CLI",
    processes: ["cli"],
    kind: "url",
    default: "http://localhost:8787",
    example: "http://localhost:8787",
    description: "`pnpm ingest <file>`: where the API is (the api itself in dev, or PUBLIC_URL in Docker).",
  },
  {
    name: "TRIAGE_API_KEY",
    group: "CLI",
    processes: ["cli"],
    kind: "string",
    secret: true,
    example: "",
    description: "`pnpm ingest <file>`: a tenant API key (create one with `pnpm api-key:create --tenant demo`).",
  },
  // ── End-to-end tests ──
  {
    name: "WEB_URL",
    group: "End-to-end tests",
    processes: ["cli"],
    kind: "url",
    default: "http://localhost:3000",
    description: "`pnpm e2e`: the running web app.",
  },
  {
    name: "API_URL",
    group: "End-to-end tests",
    processes: ["cli"],
    kind: "url",
    default: "WEB_URL/api",
    description: "`pnpm e2e`: the API, by default WEB_URL/api.",
  },
  {
    name: "CATCHER_URL",
    group: "End-to-end tests",
    processes: ["cli"],
    kind: "url",
    default: "http://localhost:9030",
    description: "`pnpm e2e`: the webhook catcher.",
  },
  {
    name: "FAKE_GOOGLE_URL",
    group: "End-to-end tests",
    processes: ["cli"],
    kind: "url",
    default: "http://localhost:9040",
    description: "`pnpm e2e`: the fake Google (`pnpm fake-google`).",
  },
  {
    name: "WALKTHROUGH_VIDEO",
    group: "End-to-end tests",
    processes: ["cli"],
    kind: "bool",
    description: "`pnpm e2e`: record videos of the walkthroughs (the README GIFs).",
  },
];

/** Variables some code reads that belong to the platform, not to this app. The source scan ignores them. */
export const PLATFORM_ENV = ["INIT_CWD", "CI", "VITEST"] as const;

export const envVar = (name: string): EnvVar | undefined => ENV_VARS.find((v) => v.name === name);

type Env = Record<string, string | undefined>;

function invalid(v: EnvVar, value: string): string | null {
  switch (v.kind) {
    case "url":
      try {
        new URL(value);
        return null;
      } catch {
        return "isn't a URL";
      }
    case "int":
      return /^\d+$/.test(value) ? null : "isn't a whole number";
    case "number":
      return Number.isFinite(Number(value)) && Number(value) >= 0 ? null : "isn't a non-negative number";
    case "bool":
      return value === "true" || value === "false" ? null : 'must be "true" or "false"';
    case "enum":
      return v.values?.includes(value) ? null : `must be one of: ${v.values?.join(", ")}`;
    default:
      return null;
  }
}

/**
 * Every problem with the environment for one process at once: missing required variables and
 * malformed values, each naming the variable and what it's for. Empty when the environment is fine.
 */
export function checkEnv(env: Env, process: EnvProcess): string[] {
  const problems: string[] = [];
  for (const v of ENV_VARS) {
    if (!v.processes.includes(process)) continue;
    const value = env[v.name]?.trim() ?? "";
    if (value === "") {
      if (v.requiredBy?.includes(process)) problems.push(`${v.name} is not set. ${v.description}`);
      continue;
    }
    const why = invalid(v, value);
    if (why) problems.push(`${v.name} ${why} (got "${v.secret ? "…" : value}")`);
  }
  return problems;
}

export class EnvError extends Error {
  override name = "EnvError";
}

/** Throws with every problem listed, pointing at the generated reference. */
export function assertEnv(env: Env, process: EnvProcess): void {
  const problems = checkEnv(env, process);
  if (problems.length === 0) return;
  throw new EnvError(
    `The ${process} can't start with this environment:\n${problems.map((p) => `  - ${p}`).join("\n")}\n` +
      "Copy .env.example to .env for local development, or see docs/configuration.md.",
  );
}

const groups = () => [...new Set(ENV_VARS.map((v) => v.group))];

/** Wraps a comment to about 100 columns. */
function comment(text: string): string[] {
  const lines: string[] = [];
  let line = "#";
  for (const word of text.split(/\s+/)) {
    if (line.length + word.length + 1 > 100 && line !== "#") {
      lines.push(line);
      line = "#";
    }
    line += ` ${word}`;
  }
  lines.push(line);
  return lines;
}

/** `.env.example`, rendered from the registry. Variables without an example stay commented out. */
export function renderEnvExample(): string {
  const out = [
    "# Copy to .env (cp .env.example .env). Ports avoid common local defaults.",
    "# Generated from packages/core/src/env.ts by `pnpm config:docs`; edit there, not here.",
    "# Every variable is described in docs/configuration.md.",
  ];
  for (const group of groups()) {
    out.push("", `# ── ${group} ──`);
    for (const v of ENV_VARS.filter((x) => x.group === group)) {
      out.push(...comment(v.description));
      out.push(v.example === undefined ? `# ${v.name}=` : `${v.name}=${v.example}`);
    }
  }
  return `${out.join("\n")}\n`;
}

const cell = (s: string) => s.replace(/\|/g, "\\|");

/** docs/configuration.md, rendered from the registry. */
export function renderConfigDoc(): string {
  const out = [
    "# Configuration",
    "",
    "> Generated from `packages/core/src/env.ts` by `pnpm config:docs`; edit there, not here.",
    "",
    "Every variable the app reads. The api and worker check theirs at startup and list every problem at once. `pnpm preflight` checks a whole installation. Secrets are marked 🔒: keep them out of logs and version control.",
    "",
    "Processes: **api**, **worker**, **web**, **cli** (migrations, seeds and the admin commands) and **compose** (only `docker compose` interpolation).",
  ];
  for (const group of groups()) {
    out.push("", `## ${group}`, "", "| Variable | Read by | Default | Description |", "|---|---|---|---|");
    for (const v of ENV_VARS.filter((x) => x.group === group)) {
      const name = `\`${v.name}\`${v.secret ? " 🔒" : ""}${v.requiredBy?.length ? ` (required: ${v.requiredBy.join(", ")})` : ""}`;
      const kind = v.kind === "enum" ? `one of ${v.values?.map((x) => `\`${x}\``).join(", ")}. ` : "";
      out.push(
        `| ${name} | ${v.processes.join(", ")} | ${v.default ? `\`${cell(v.default)}\`` : "–"} | ${cell(kind + v.description)} |`,
      );
    }
  }
  return `${out.join("\n")}\n`;
}

export interface PublicUrls {
  /** The origin people use: the web app, with the API at `${origin}/api`. */
  origin: string;
  /** Better Auth's baseURL (it serves /api/auth on it). */
  authBaseUrl: string;
  /** Prefix of the api's own routes, for OAuth redirect URIs. */
  apiBaseUrl: string;
  /** Settings that are ignored, worth a warning at startup. */
  warnings: string[];
}

/**
 * One public URL (docs/architecture.md §2): PUBLIC_URL, else the older WEB_ORIGIN, else localhost.
 * Throws on a URL with a path, which would break cookies and the auth routes.
 */
export function resolvePublicUrls(env: Env): PublicUrls {
  const raw = env.PUBLIC_URL?.trim() || env.WEB_ORIGIN?.trim() || "http://localhost:3000";
  const url = new URL(raw);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new EnvError(`PUBLIC_URL must be an origin with no path (got "${raw}"): the API lives at /api on it`);
  }
  const origin = url.origin;
  const warnings: string[] = [];
  const auth = env.BETTER_AUTH_URL?.trim();
  if (auth && new URL(auth).origin !== origin) {
    warnings.push(`BETTER_AUTH_URL (${auth}) is ignored: auth now runs at ${origin}/api/auth`);
  }
  if (env.NEXT_PUBLIC_API_URL?.trim()) {
    warnings.push("NEXT_PUBLIC_API_URL is ignored: the browser calls the API at /api on the same origin");
  }
  return { origin, authBaseUrl: origin, apiBaseUrl: `${origin}/api`, warnings };
}
