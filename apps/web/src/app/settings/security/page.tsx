import { getMe } from "@/components/header";
import { SecurityView } from "./security-view";

export default async function SecurityPage() {
  const me = await getMe();
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
      {me ? (
        <SecurityView
          email={me.user.email}
          twoFactorEnabled={me.twoFactorEnabled}
          twoFactorRequired={me.twoFactorRequired}
        />
      ) : (
        <p className="mt-6 text-sm text-red-600">Sign in to manage your account.</p>
      )}
    </main>
  );
}
