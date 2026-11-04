import { getMe } from "@/lib/session";
import { SettingsFrame } from "../settings-frame";
import { SecurityView } from "./security-view";

export default async function SecurityPage() {
  const me = await getMe();
  return (
    <SettingsFrame
      title="Account security"
      description="How you sign in, and where you are signed in."
      isAdmin={me?.role === "admin"}
    >
      {me && (
        <SecurityView
          name={me.user.name}
          email={me.user.email}
          role={me.role}
          twoFactorEnabled={me.twoFactorEnabled}
          twoFactorRequired={me.twoFactorRequired}
        />
      )}
    </SettingsFrame>
  );
}
