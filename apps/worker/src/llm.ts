import {
  createDb,
  findModelPrice,
  findReusableAttempt,
  insertAttempt,
  type Pool,
  reserveBudget,
  settleBudget,
  withTenantTx,
} from "@ai-triage/db";
import { createLlmGateway, type GatewayHooks, type LlmMode, type Transport } from "@ai-triage/llm";

/**
 * The LLM gateway wired to Postgres: attempts in llm_calls (each saved in its own small
 * transaction), the per-tenant daily budget, and model prices. Shared by the pipeline and, in
 * phase 4, the eval runner (with eval run + item contexts).
 */
export function createDbLlmGateway(input: { pool: Pool; mode: LlmMode; transport: Transport; hooks?: GatewayHooks }) {
  const { pool } = input;
  const db = createDb(pool);
  return createLlmGateway({
    mode: input.mode,
    transport: input.transport,
    hooks: input.hooks,
    store: {
      findReusable: (tenantId, ctx, stage) => withTenantTx(pool, tenantId, (tx) => findReusableAttempt(tx, ctx, stage)),
      insert: (tenantId, ctx, attempt) => insertAttempt(pool, tenantId, ctx, attempt),
    },
    budget: {
      reserve: (tenantId, usd) => reserveBudget(pool, tenantId, usd),
      settle: (tenantId, day, reserved, actual) => settleBudget(pool, tenantId, day, reserved, actual),
    },
    findPrice: (model, promptTokens) => findModelPrice(db, model, promptTokens),
  });
}
