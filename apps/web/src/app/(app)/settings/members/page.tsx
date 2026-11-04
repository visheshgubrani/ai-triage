import { AdminSettings } from "../admin-gate";
import { MembersView } from "./members-view";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  return (
    <AdminSettings title="Members" current="/settings/members">
      <MembersView />
    </AdminSettings>
  );
}
