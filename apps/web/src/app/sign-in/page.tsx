"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { GoogleButton } from "@/components/google-button";
import { authClient } from "@/lib/auth-client";
import { googleEnabled, signInErrorText } from "@/lib/google";

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
  const [google, setGoogle] = useState(false);

  // Back from Google: `?step=two-factor` (the account has 2FA, so the code comes next) or `?error=`.
  // Read once from the URL, without useSearchParams, so the page needs no Suspense boundary.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("step") === "two-factor") setNeedsCode(true);
    const code = params.get("error");
    if (code) setError(signInErrorText(code));
    void googleEnabled().then(setGoogle);
  }, []);

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
        <>
          {google && (
            <div className="mt-6 space-y-4">
              <GoogleButton onError={setError} />
              <p className="text-center text-xs text-neutral-500">or with your email and password</p>
            </div>
          )}
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
        </>
      )}
    </main>
  );
}
