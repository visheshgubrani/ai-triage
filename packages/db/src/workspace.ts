import type { InvitationAcceptMethod } from "@ai-triage/core";
import { type AuditActor, recordAudit } from "./audit";
import type { Pool } from "./index";
import { createInvitation } from "./members";
import { buildPipelineConfig } from "./pipeline-config";
import { withTenantTx } from "./tenant-tx";
import { createTenant } from "./tenants";

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
    now: Date;
  },
): Promise<{ tenantId: string; token: string }> {
  const { id } = await createTenant(pool, { name: input.name, slug: input.slug, inboundDomain: input.inboundDomain });
  const token = await withTenantTx(pool, id, async (tx) => {
    const config = await buildPipelineConfig(tx, { name: "Default config" });
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
