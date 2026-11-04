import { AdminSettings } from "./admin-gate";
import { BudgetSettingsView } from "./budget-settings";
import { IntakeSettingsView } from "./intake-settings";
import { RetentionSettingsView } from "./retention-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  return (
    <AdminSettings title="General" current="/settings">
      <IntakeSettingsView />
      <BudgetSettingsView />
      <RetentionSettingsView />
    </AdminSettings>
  );
}
