import Link from "next/link";
import { getMe } from "@/components/header";
import { ApiKeysView } from "./api-keys";
import { AuditLogView } from "./audit-log";
import { BudgetSettingsView } from "./budget-settings";
import { InboundSettingsView } from "./inbound-settings";
import { RetentionSettingsView } from "./retention-settings";
import { WebhookSettingsView } from "./webhook-settings";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const me = await getMe();
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        {me && (
          <Link href="/settings/security" className="text-sm underline">
            Your account security
          </Link>
        )}
      </div>
      {me?.role !== "admin" ? (
        <p className="mt-6 text-sm text-red-600">Only a tenant admin can change settings.</p>
      ) : me.twoFactorRequired ? (
        <p className="mt-6 text-sm text-amber-700 dark:text-amber-300">
          Admin settings need two-factor authentication.{" "}
          <Link href="/settings/security" className="underline">
            Turn it on
          </Link>{" "}
          to continue.
        </p>
      ) : (
        <>
          <InboundSettingsView />
          <WebhookSettingsView />
          <ApiKeysView />
          <BudgetSettingsView />
          <RetentionSettingsView />
          <AuditLogView />
        </>
      )}
    </main>
  );
}
