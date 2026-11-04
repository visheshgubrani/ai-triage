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
      "Basic-auth user in the Postmark inbound webhook URL (https://user:pass@host/webhooks/postmark). Unset with the password: the webhook is off.",
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
      "Domain of generated (unguessable) inbound addresses. Empty: new tenants get no address, and existing ones keep their domain.",
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
    name: "WEB_ORIGIN",
    group: "API and web",
    processes: ["api", "cli"],
    kind: "url",
    default: "http://localhost:3000",
    example: "http://localhost:3000",
    description: "Origin of the web app: CORS, the Origin check, invite links, OAuth redirects back to the UI.",
  },
  {
    name: "API_INTERNAL_URL",
    group: "API and web",
    processes: ["web"],
    kind: "url",
    default: "NEXT_PUBLIC_API_URL",
    description: "How the web server reaches the api (in compose: http://api:8787). The browser never uses it.",
  },
  {
    name: "NEXT_PUBLIC_API_URL",
    group: "API and web",
    processes: ["web"],
    kind: "url",
    default: "http://localhost:8787",
    example: "http://localhost:8787",
    description: "The api as the browser sees it. Inlined into the web bundle at build time.",
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
    default: "http://localhost:<API_PORT>",
    example: "http://localhost:8787",
    description: "Public base URL of the api, for auth callbacks. Must be https in production.",
  },
  // ── Google ──
  {
    name: "GOOGLE_CLIENT_ID",
    group: "Google",
    processes: SERVER,
    kind: "string",
    example: "",
    description:
      "One OAuth client for Sign in with Google and Gmail mailbox sync (docs/google.md). Leave it and the secret empty to hide every Google feature. Redirect URIs to register: <BETTER_AUTH_URL>/api/auth/callback/google and <BETTER_AUTH_URL>/integrations/google/callback.",
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
  // ── CLI ──
  {
    name: "TRIAGE_API_URL",
    group: "CLI",
    processes: ["cli"],
    kind: "url",
    default: "http://localhost:8787",
    example: "http://localhost:8787",
    description: "`pnpm ingest <file>`: the API base URL.",
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
    default: "http://localhost:8787",
    description: "`pnpm e2e`: the running api.",
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
