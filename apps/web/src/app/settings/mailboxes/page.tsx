import { AdminSettings } from "../admin-gate";
import { MailboxesView } from "./mailboxes-view";

export const dynamic = "force-dynamic";

export default async function MailboxesPage() {
  return (
    <AdminSettings title="Mailboxes" current="/settings/mailboxes">
      <MailboxesView />
    </AdminSettings>
  );
}
