import type { ModelCapabilities } from "@ai-triage/core";
import { modelBlocker } from "@ai-triage/core";
import { sql } from "drizzle-orm";
import { getActiveConfig } from "./configs";
import { liveWorkers } from "./heartbeats";
import type { Db } from "./index";
import type { TenantTx } from "./tenant-tx";

// The getting-started checklist (docs/deploy.md): facts read from the tenant's own data, so nothing
// is stored but its dismissal. The api turns them into steps with text and links.

export interface OnboardingFacts {
  dismissed: boolean;
  /** Null when the active config can run on a live worker; else why not (no worker, no key, ...). */
  modelBlocker: string | null;
  configVersions: number;
  customCategories: number;
  documents: number;
  processed: number;
  intakeConnected: boolean;
  webhookSet: boolean;
  webhookVerified: boolean;
  members: number;
  pendingInvitations: number;
  labeledItems: number;
  frozenConfigs: number;
  automating: boolean;
}

export async function onboardingFacts(tx: TenantTx, db: Db, now: Date): Promise<OnboardingFacts> {
  const config = await getActiveConfig(tx);
  const workers = await liveWorkers(db, now);
  let blocker: string | null = "no worker is running";
  if (config && workers.length > 0) {
    const stages = [
      { model: config.classifyModel, effort: config.classifyEffort },
      { model: config.extractModel, effort: config.extractEffort },
    ];
    const reasons = workers.map((w) => {
      const caps: ModelCapabilities = { llmMode: w.llmMode, ...w.capabilities };
      return stages.map((s) => modelBlocker(s, caps)).find((r) => r !== null) ?? null;
    });
    blocker = reasons.includes(null) ? null : (reasons[0] ?? null);
  } else if (!config) {
    blocker = "the workspace has no active pipeline config";
  }
  const [f] = (
    await tx.db.execute<Record<string, number | boolean | string | null>>(sql`
      select
        (select onboarding_dismissed_at is not null from tenant_settings) as dismissed,
        (select count(*)::int from pipeline_configs) as config_versions,
        (select count(distinct category)::int from category_schema_versions
          where origin = 'custom') as custom_categories,
        (select count(*)::int from documents) as documents,
        (select count(*)::int from documents where processing_status = 'done') as processed,
        (select count(*)::int from mailbox_connections where status = 'active')
          + (select count(*)::int from api_keys where revoked_at is null) as intake,
        (select webhook_url is not null from tenant_settings) as webhook_set,
        (select webhook_tested_at is not null from tenant_settings)
          or exists (select 1 from actions where status = 'delivered') as webhook_verified,
        (select count(*)::int from eval_items where retired_at is null) as labeled,
        (select count(*)::int from pipeline_configs where frozen_at is not null) as frozen`)
  ).rows;
  const [people] = (
    await db.execute<{ members: number; pending: number }>(sql`
      select (select count(*)::int from memberships where organization_id = ${tx.tenantId}) as members,
             (select count(*)::int from invitations
               where organization_id = ${tx.tenantId} and status = 'pending' and expires_at > now()) as pending`)
  ).rows;
  return {
    dismissed: f?.dismissed === true,
    modelBlocker: blocker,
    configVersions: Number(f?.config_versions ?? 0),
    customCategories: Number(f?.custom_categories ?? 0),
    documents: Number(f?.documents ?? 0),
    processed: Number(f?.processed ?? 0),
    intakeConnected: Number(f?.intake ?? 0) > 0 || Number(f?.documents ?? 0) > 0,
    webhookSet: f?.webhook_set === true,
    webhookVerified: f?.webhook_verified === true,
    members: people?.members ?? 0,
    pendingInvitations: people?.pending ?? 0,
    labeledItems: Number(f?.labeled ?? 0),
    frozenConfigs: Number(f?.frozen ?? 0),
    automating: config?.categories.some((c) => c.automation === "auto_when_confident") ?? false,
  };
}

export async function dismissOnboarding(tx: TenantTx, now: Date): Promise<void> {
  await tx.db.execute(sql`update tenant_settings set onboarding_dismissed_at = ${now.toISOString()}::timestamptz`);
}

/** A Settings test event the receiver accepted: the checklist's webhook step is done. */
export async function markWebhookTested(tx: TenantTx, now: Date): Promise<void> {
  await tx.db.execute(sql`update tenant_settings set webhook_tested_at = ${now.toISOString()}::timestamptz`);
}
