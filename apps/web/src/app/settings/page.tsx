import { AdminSettings } from "./admin-gate";
import { ApiKeysView } from "./api-keys";
import { AuditLogView } from "./audit-log";
import { BudgetSettingsView } from "./budget-settings";
import { InboundSettingsView } from "./inbound-settings";
import { RetentionSettingsView } from "./retention-settings";
import { WebhookSettingsView } from "./webhook-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  return (
    <AdminSettings title="Settings" current="/settings">
      <InboundSettingsView />
      <WebhookSettingsView />
      <ApiKeysView />
      <BudgetSettingsView />
      <RetentionSettingsView />
      <AuditLogView />
    </AdminSettings>
  );
}
