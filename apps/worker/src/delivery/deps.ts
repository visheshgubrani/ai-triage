import type { PgBoss, Pool } from "@ai-triage/db";

/**
 * Everything webhook delivery touches. No LLM, storage or pipeline port: and the eval runner is never
 * given these deps, so no eval code path can reach a webhook (invariant 7).
 */
export interface DeliveryDeps {
  pool: Pool;
  boss: PgBoss;
  fetch: typeof fetch;
  now: () => Date;
  /** Per attempt; a timeout counts as a transient failure and is retried. */
  timeoutMs: number;
}
