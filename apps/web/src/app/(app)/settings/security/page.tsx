import { getMe } from "@/lib/session";
import { SettingsFrame } from "../settings-frame";
import { SecurityView } from "./security-view";

export default async function SecurityPage() {
  const me = await getMe();
  return (
    <SettingsFrame
      title="Account security"
      description="Your own password, two-factor authentication and sessions."
      isAdmin={me?.role === "admin"}
    >
      {me && (
        <SecurityView
          email={me.user.email}
          twoFactorEnabled={me.twoFactorEnabled}
          twoFactorRequired={me.twoFactorRequired}
        />
      )}
    </SettingsFrame>
  );
}
