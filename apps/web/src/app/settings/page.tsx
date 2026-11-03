import { getMe } from "@/components/header";
import { AuditLogView } from "./audit-log";
import { BudgetSettingsView } from "./budget-settings";
import { WebhookSettingsView } from "./webhook-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await getMe();
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      {me?.role === "admin" ? (
        <>
          <WebhookSettingsView />
          <BudgetSettingsView />
          <AuditLogView />
        </>
      ) : (
        <p className="mt-6 text-sm text-red-600">Only a tenant admin can change settings.</p>
      )}
    </main>
  );
}
