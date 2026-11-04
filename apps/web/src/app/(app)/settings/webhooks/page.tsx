import { AdminSettings } from "../admin-gate";
import { WebhookSettingsView } from "./webhooks-view";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  return (
    <AdminSettings title="Webhooks" current="/settings/webhooks">
      <WebhookSettingsView />
    </AdminSettings>
  );
}
