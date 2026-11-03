"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { authClient } from "@/lib/auth-client";

const input =
  "mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700";
const button =
  "w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** After the password: the account has 2FA, so a code from the authenticator app (or a backup code). */
  const [needsCode, setNeedsCode] = useState(false);
  const [backup, setBackup] = useState(false);

  function done() {
    router.push("/");
    router.refresh();
  }

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) return setError(error.message ?? "Sign-in failed");
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setNeedsCode(true);
    done();
  }

  async function onCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (error) return setError(error.message ?? "That code didn't work");
    done();
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      {needsCode ? (
        <form onSubmit={onCode} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            {backup ? "Backup code" : "Code from your authenticator app"}
            <input
              name="code"
              required
              autoComplete="one-time-code"
              inputMode={backup ? "text" : "numeric"}
              className={input}
            />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button type="submit" disabled={pending} className={button}>
            {pending ? "Checking…" : "Verify"}
          </button>
          <button type="button" className="text-sm underline" onClick={() => setBackup(!backup)}>
            {backup ? "Use the authenticator app" : "Use a backup code"}
          </button>
        </form>
      ) : (
        <form onSubmit={onPassword} className="mt-6 space-y-4">
          <label className="block text-sm font-medium">
            Email
            <input name="email" type="email" autoComplete="email" required className={input} />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input name="password" type="password" autoComplete="current-password" required className={input} />
          </label>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <button type="submit" disabled={pending} className={button}>
            {pending ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
    </main>
  );
}
