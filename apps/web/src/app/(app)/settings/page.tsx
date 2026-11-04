import type { ReactNode } from "react";
import { AdminSettings } from "./admin-gate";
import { ApiKeysView } from "./api-keys";
import { AuditLogView } from "./audit-log";
import { BudgetSettingsView } from "./budget-settings";
import { InboundSettingsView } from "./inbound-settings";
import { IntakeSettingsView } from "./intake-settings";
import { RetentionSettingsView } from "./retention-settings";
import { WebhookSettingsView } from "./webhook-settings";

export const dynamic = "force-dynamic";

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="mt-8 first:mt-6">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h2>
      <div className="[&>section]:mt-3">{children}</div>
    </div>
  );
}

export default async function SettingsPage() {
  return (
    <AdminSettings title="Settings" current="/settings">
      <Group id="intake" title="Intake">
        <InboundSettingsView />
        <IntakeSettingsView />
      </Group>
      <Group id="delivery" title="Delivery">
        <WebhookSettingsView />
      </Group>
      <Group id="access" title="Access">
        <ApiKeysView />
      </Group>
      <Group id="limits" title="Limits">
        <BudgetSettingsView />
        <RetentionSettingsView />
      </Group>
      <Group id="audit" title="Audit log">
        <AuditLogView />
      </Group>
    </AdminSettings>
  );
}
