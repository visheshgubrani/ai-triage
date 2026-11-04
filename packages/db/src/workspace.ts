import { type Effort, type InvitationAcceptMethod, isModelRef, type ModelRef, modelInfo } from "@ai-triage/core";
import { type AuditActor, recordAudit } from "./audit";
import type { Pool } from "./index";
import { createInvitation } from "./members";
import { buildPipelineConfig } from "./pipeline-config";
import { withTenantTx } from "./tenant-tx";
import { createTenant } from "./tenants";

/** A model at low effort when it takes one, else at its first (sim and local models: `none`). */
function defaultStage(model: ModelRef): { model: ModelRef; effort: Effort } {
  const { efforts } = modelInfo(model);
  return { model, effort: efforts.includes("low") ? "low" : (efforts[0] ?? "none") };
}

/** DEFAULT_MODEL, if it names a catalog model; null leaves the built-in default. */
export function defaultModelFromEnv(env: Record<string, string | undefined>): ModelRef | undefined {
  const ref = env.DEFAULT_MODEL;
  if (!ref) return undefined;
  if (!isModelRef(ref)) throw new Error(`DEFAULT_MODEL "${ref}" is not a catalog model`);
  return ref;
}

/**
 * A new workspace ready for its first admin (`pnpm tenant:create` and the first-run setup page):
 * the tenant, its settings and inbound address, a default pipeline config (every category reviewed
 * by a person), and an admin invitation whose one-time token goes in the invite link.
 */
export async function createWorkspace(
  pool: Pool,
  input: {
    name: string;
    slug: string;
    adminEmail: string;
    acceptWith: InvitationAcceptMethod;
    actor: AuditActor;
    inboundDomain?: string;
    /** Both stages' model for the first config (DEFAULT_MODEL); Opus 5.5 at low effort otherwise. */
    model?: ModelRef;
    now: Date;
  },
): Promise<{ tenantId: string; token: string }> {
  const { id } = await createTenant(pool, { name: input.name, slug: input.slug, inboundDomain: input.inboundDomain });
  const token = await withTenantTx(pool, id, async (tx) => {
    const stage = input.model ? defaultStage(input.model) : undefined;
    const config = await buildPipelineConfig(tx, { name: "Default config", classify: stage, extract: stage });
    await recordAudit(tx, input.actor, {
      action: "config.created",
      target: { type: "config", id: config.id },
      details: { name: "Default config", activated: true },
    });
    const { token } = await createInvitation(tx, input.actor, {
      email: input.adminEmail,
      role: "admin",
      acceptWith: input.acceptWith,
      inviterId: null,
      now: input.now,
    });
    return token;
  });
  return { tenantId: id, token };
}
