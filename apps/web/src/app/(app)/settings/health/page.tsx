import { AdminSettings } from "../admin-gate";
import { HealthView } from "./health-view";

export const dynamic = "force-dynamic";

export default async function HealthPage() {
  return (
    <AdminSettings title="System health" current="/settings/health">
      <HealthView />
    </AdminSettings>
  );
}
