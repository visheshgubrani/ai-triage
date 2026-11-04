import { randomBytes } from "node:crypto";

// `cli configure` (docs/install.md): the `.env` of an installation made by install.sh, next to
// deploy/compose.yaml. Pure, so it's tested here; the bin does the file IO. Re-running keeps every
// existing value (secrets above all: a new database password would lock the app out of its data)
// and changes only what the flags say, which makes it the upgrade path too.

export const OCR_BACKENDS = ["nvidia", "vulkan", "rocm", "cpu"] as const;
export type OcrBackend = (typeof OCR_BACKENDS)[number];

export interface InstallOptions {
  /** Absent: a local install, on http://localhost:3000. */
  host?: string;
  /** Let's Encrypt account email (server installs). */
  email?: string;
  /** Image tag to run (`TRIAGE_VERSION`). */
  version?: string;
  ocr?: OcrBackend | "off";
  /** A local install's port (the app; files on the next one). Default 3000. */
  port?: number;
}

/** Provider keys taken from the installer's environment, never from its arguments. */
export const PROVIDER_KEYS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"] as const;

/** A new workspace's first model for the first provider key present (DEFAULT_MODEL). */
const MODEL_FOR_KEY: Record<(typeof PROVIDER_KEYS)[number], string> = {
  ANTHROPIC_API_KEY: "claude-opus-5-5",
  OPENAI_API_KEY: "openai:gpt-6.1-terra",
  DEEPSEEK_API_KEY: "deepseek:deepseek-flash",
  OPENROUTER_API_KEY: "openrouter:openai/gpt-6.1-terra",
};

export const LOCAL_APP_PORT = 3000;
export const SERVER_FILES_PORT = 8443;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export class ConfigureError extends Error {}

type Random = (bytes: number) => Buffer;

const secret = (random: Random, bytes: number) => random(bytes).toString("base64url");

/** `.env` parsed: KEY=VALUE lines, comments and blanks ignored, no quoting (configure never quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m?.[1]) out[m[1]] = m[2] ?? "";
  }
  return out;
}

/** The installation's settings: existing values kept, flags applied, missing secrets generated. */
export function configure(
  existing: Record<string, string>,
  options: InstallOptions,
  env: Record<string, string | undefined>,
  random: Random = randomBytes,
): Record<string, string> {
  const host = options.host?.trim().toLowerCase() || existing.APP_HOST || undefined;
  if (host && host !== "localhost" && !HOSTNAME.test(host)) {
    throw new ConfigureError(`"${host}" isn't a hostname (give the name only, such as triage.acme.com)`);
  }
  const server = host !== undefined && host !== "localhost";
  const email = options.email?.trim() || existing.ACME_EMAIL || "";
  if (server && !email.includes("@")) {
    throw new ConfigureError("a server install needs --email: Let's Encrypt sends certificate notices there");
  }
  const ocr = options.ocr ?? (existing.OCR_BACKEND as OcrBackend | undefined) ?? "off";

  const keep = (name: string, make: () => string) => existing[name] || make();
  const postgresPassword = keep("POSTGRES_PASSWORD", () => secret(random, 24));
  const appPassword = keep("DATABASE_APP_PASSWORD", () => secret(random, 24));
  const keys = Object.fromEntries(
    PROVIDER_KEYS.map((k) => [k, env[k]?.trim() || existing[k] || ""] as const),
  ) as Record<(typeof PROVIDER_KEYS)[number], string>;
  const firstKey = PROVIDER_KEYS.find((k) => keys[k]);

  const port = options.port ?? (Number(existing.APP_PORT) || LOCAL_APP_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new ConfigureError("--port must be 1024 to 65534");
  const publicUrl = server ? `https://${host}` : `http://localhost:${port}`;
  const filesUrl = server ? `https://${host}:${SERVER_FILES_PORT}` : `http://localhost:${port + 1}`;
  const composeFiles = ["compose.yaml", server ? "compose.server.yaml" : "compose.local.yaml"];
  if (ocr !== "off") composeFiles.push(`compose.ocr-${ocr}.yaml`);

  const values: Record<string, string> = {
    // How `docker compose` (and ./triage) run this installation.
    // Not "ai-triage": that's the repository's demo and dev stack, whose containers and volumes
    // an installation must never adopt.
    COMPOSE_PROJECT_NAME: existing.COMPOSE_PROJECT_NAME || "ai-triage-install",
    COMPOSE_FILE: composeFiles.join(":"),
    // Bundled Postgres and storage. To use your own, remove this line and set DATABASE_*_URL and S3_*.
    COMPOSE_PROFILES: existing.COMPOSE_PROFILES ?? "bundled",
    TRIAGE_VERSION: options.version || existing.TRIAGE_VERSION || "latest",
    // Addresses.
    APP_HOST: host ?? "localhost",
    APP_PORT: String(port),
    FILES_PORT: String(port + 1),
    APP_SITE: server ? (host as string) : `http://:${port}`,
    FILES_SITE: server ? `${host}:${SERVER_FILES_PORT}` : `http://:${port + 1}`,
    ACME_EMAIL: email || "admin@localhost",
    PUBLIC_URL: publicUrl,
    S3_PUBLIC_ENDPOINT: filesUrl,
    // Database: the owner runs migrations only; the app connects as a role that RLS applies to.
    POSTGRES_PASSWORD: postgresPassword,
    DATABASE_APP_PASSWORD: appPassword,
    DATABASE_OWNER_URL: existing.DATABASE_OWNER_URL || `postgres://triage:${postgresPassword}@postgres:5432/triage`,
    DATABASE_URL: existing.DATABASE_URL || `postgres://triage_app:${appPassword}@postgres:5432/triage`,
    // Object storage.
    S3_ENDPOINT: existing.S3_ENDPOINT || "http://storage:9000",
    S3_BUCKET: existing.S3_BUCKET || "triage",
    S3_REGION: existing.S3_REGION || "us-east-1",
    S3_ACCESS_KEY_ID: keep("S3_ACCESS_KEY_ID", () => `triage-${secret(random, 6)}`),
    S3_SECRET_ACCESS_KEY: keep("S3_SECRET_ACCESS_KEY", () => secret(random, 30)),
    // Secrets.
    BETTER_AUTH_SECRET: keep("BETTER_AUTH_SECRET", () => secret(random, 36)),
    ENCRYPTION_KEYS: keep("ENCRYPTION_KEYS", () => `k1:${random(32).toString("base64")}`),
    POSTMARK_INBOUND_USER: existing.POSTMARK_INBOUND_USER || "postmark",
    POSTMARK_INBOUND_PASSWORD: keep("POSTMARK_INBOUND_PASSWORD", () => secret(random, 24)),
    // Email in (docs/install.md, "Connect your email"): your Postmark server's inbound address.
    INBOUND_DOMAIN: existing.INBOUND_DOMAIN ?? "",
    // Models: live calls with your key. Without one, the getting-started checklist says what to set.
    LLM_MODE: existing.LLM_MODE || "live",
    DEFAULT_MODEL: existing.DEFAULT_MODEL || (firstKey ? MODEL_FOR_KEY[firstKey] : "claude-opus-5-5"),
    ...keys,
    OCR_BACKEND: ocr,
  };
  // Anything else an operator added by hand (Google, WEBHOOK_ALLOWED_HOSTS, …) stays.
  for (const [k, v] of Object.entries(existing)) if (!(k in values)) values[k] = v;
  return values;
}

/**
 * What a restore takes from a backup's .env: what the restored data needs (the encryption keys
 * decrypt webhook secrets and mailbox tokens; Postmark's webhook URL carries its credentials) and
 * what was configured by hand. The new installation keeps its own database and storage passwords
 * and addresses: its Postgres cluster and RustFS were initialized with those.
 */
export const RESTORED_KEYS = [
  "ENCRYPTION_KEYS",
  "BETTER_AUTH_SECRET",
  "POSTMARK_INBOUND_USER",
  "POSTMARK_INBOUND_PASSWORD",
  "INBOUND_DOMAIN",
  "DEFAULT_MODEL",
  "LLM_MODE",
  "METRICS_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "WEBHOOK_ALLOWED_HOSTS",
  ...PROVIDER_KEYS,
] as const;

export function mergeRestored(current: Record<string, string>, backup: Record<string, string>): Record<string, string> {
  const out = { ...current };
  for (const k of RESTORED_KEYS) if (backup[k] !== undefined) out[k] = backup[k];
  return out;
}

const HEADER = `# Written by \`cli configure\` (install.sh). Edit values here, then \`./triage restart\`.
# Every variable is described in docs/configuration.md. Keep this file private: it holds secrets.
`;

export function renderEnvFile(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new ConfigureError(`${k} has a line break`);
    return `${k}=${v}`;
  });
  return `${HEADER}\n${lines.join("\n")}\n`;
}
