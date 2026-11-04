"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { GoogleButton, OrDivider } from "@/components/google-button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { googleEnabled, safeNext, signInErrorText } from "@/lib/google";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /** After the password: the account has 2FA, so a code from the authenticator app (or a backup code). */
  const [needsCode, setNeedsCode] = useState(false);
  const [backup, setBackup] = useState(false);
  const [google, setGoogle] = useState(false);
  const [next, setNext] = useState("/");

  // Back from Google: `?step=two-factor` (the account has 2FA, so the code comes next) or `?error=`.
  // Read once from the URL, without useSearchParams, so the page needs no Suspense boundary.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("step") === "two-factor") setNeedsCode(true);
    const code = params.get("error");
    if (code) setError(signInErrorText(code));
    setNext(safeNext(params.get("next")));
    void googleEnabled().then(setGoogle);
  }, []);

  function done() {
    router.push(next);
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
    <>
      <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Welcome back. Your documents are waiting.</p>
      {needsCode ? (
        <form onSubmit={onCode} className="mt-6 space-y-4">
          <Field label={backup ? "Backup code" : "Code from your authenticator app"}>
            <Input name="code" required autoComplete="one-time-code" inputMode={backup ? "text" : "numeric"} />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={pending} className="w-full">
            {pending ? "Checking…" : "Verify"}
          </Button>
          <Button variant="link" size="sm" className="px-0" onClick={() => setBackup(!backup)}>
            {backup ? "Use the authenticator app" : "Use a backup code"}
          </Button>
        </form>
      ) : (
        <>
          {google && (
            <div className="mt-6 space-y-4">
              <GoogleButton returnTo={next} onError={setError} />
              <OrDivider>or with your email and password</OrDivider>
            </div>
          )}
          <form onSubmit={onPassword} className={`space-y-4 ${google ? "mt-4" : "mt-6"}`}>
            <Field label="Email">
              <Input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label="Password">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" disabled={pending} className="w-full">
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </>
      )}
    </>
  );
}
