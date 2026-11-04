import { AdminSettings } from "../admin-gate";
import { ApiKeysView } from "./api-keys-view";

export const dynamic = "force-dynamic";

export default async function ApiKeysPage() {
  return (
    <AdminSettings title="API keys" current="/settings/api-keys">
      <ApiKeysView />
    </AdminSettings>
  );
}
