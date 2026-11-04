import { AdminSettings } from "../admin-gate";
import { AuditLogView } from "./audit-view";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  return (
    <AdminSettings title="Audit log" current="/settings/audit">
      <AuditLogView />
    </AdminSettings>
  );
}
