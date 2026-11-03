import type { LlmCallMode } from "@ai-triage/core";
import type { Auth, Db, PgBoss, Pool } from "@ai-triage/db";
import type { IngestLimits } from "@ai-triage/ingest";
import type { Storage } from "@ai-triage/storage";

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
  /** The web app's origin: allowed by CORS with credentials, and trusted by Better Auth. */
  webOrigin: string;
  /** The clock for claims and leases (injected so tests can let a lease run out). */
  now: () => Date;
  /** Tenants may set an http: webhook URL only when this is on (local development). */
  webhooks: { allowHttp: boolean };
  /** How eval runs started now will call models (from LLM_MODE); the worker refuses a run that differs. */
  llmMode: LlmCallMode;
}
