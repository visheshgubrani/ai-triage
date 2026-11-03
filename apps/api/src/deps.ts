import type { LlmCallMode } from "@ai-triage/core";
import type { Auth, Db, KeyRing, PgBoss, Pool } from "@ai-triage/db";
import type { IngestLimits } from "@ai-triage/ingest";
import type { Storage } from "@ai-triage/storage";
import type { parseTrustedProxies } from "./client-ip";
import type { RateLimits } from "./rate-limit";
import type { WebhookEgress } from "./webhook-url";

export interface AppDeps {
  db: Db;
  /** For tenant transactions (withTenantTx). */
  pool: Pool;
  auth: Auth;
  /** Started, without supervision or scheduling: the api only sends jobs (inside transactions). */
  boss: PgBoss;
  storage: Storage;
  limits: IngestLimits;
  /** Basic-auth credentials Postmark sends with inbound webhooks; null disables the endpoint. */
  postmark: { user: string; password: string } | null;
  /** The web app's origin: allowed by CORS with credentials, trusted by Better Auth, and the only Origin writes may come from. */
  webOrigin: string;
  /** Send Strict-Transport-Security (the API is served over https). */
  hsts: boolean;
  /** Proxies whose X-Forwarded-For is believed (TRUSTED_PROXIES), for audit and rate-limit IPs. */
  trustedProxies: ReturnType<typeof parseTrustedProxies>;
  /** The clock for claims and leases (injected so tests can let a lease run out). */
  now: () => Date;
  /** What webhook URLs may point at (WEBHOOK_ALLOWED_HOSTS, TRIAGE_DEMO), and how hosts resolve. */
  webhookEgress: WebhookEgress;
  /** Encrypts and decrypts webhook signing secrets (ENCRYPTION_KEYS). */
  keys: KeyRing;
  /** Domain of generated inbound addresses (INBOUND_DOMAIN); null keeps the current address's domain. */
  inboundDomain: string | null;
  /** Request limits (RATE_LIMITS, scaled by RATE_LIMIT_SCALE); tests lower them. */
  rateLimits: RateLimits;
  /** How eval runs started now will call models (from LLM_MODE); the worker refuses a run that differs. */
  llmMode: LlmCallMode;
}
