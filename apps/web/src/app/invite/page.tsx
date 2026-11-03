"use client";

import type { InvitationPreview } from "@ai-triage/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { GoogleButton } from "@/components/google-button";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { authClient } from "@/lib/auth-client";
import { signInErrorText } from "@/lib/google";

const input =
  "mt-1 w-full rounded-md border border-neutral-300 bg-transparent px-3 py-2 text-sm dark:border-neutral-700";
const button =
  "w-full rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

/**
 * The token sits in the link's fragment (`/invite#<token>`), which browsers never send to a server.
 * It's kept in sessionStorage so it survives the trip to Google and back, then dropped once used.
 */
const TOKEN_KEY = "ai-triage:invite-token";

export default function InvitePage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [signedInAs, setSignedInAs] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const fromLink = window.location.hash.slice(1);
    if (fromLink) {
      sessionStorage.setItem(TOKEN_KEY, fromLink);
      window.history.replaceState(null, "", "/invite");
    }
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setError(signInErrorText(code));
    const saved = fromLink || sessionStorage.getItem(TOKEN_KEY);
    if (!saved) {
      setError("Open the invitation link you were sent: this page needs it.");
      return;
    }
    setToken(saved);
    void (async () => {
      const res = await browserApi.invitations.lookup.$post({ json: { token: saved } });
      if (!res.ok) return setError((await readError(res)).error);
      setPreview(await res.json());
      const { data } = await authClient.getSession();
      setSignedInAs(data?.user.email ?? null);
    })();
  }, []);

  function joined() {
    sessionStorage.removeItem(TOKEN_KEY);
    router.push("/");
    router.refresh();
  }

  async function accept() {
    if (!token) return;
    setPending(true);
    const res = await browserApi.invitations.accept.$post({ json: { token } });
    setPending(false);
    if (!res.ok) return setError((await readError(res)).error);
    joined();
  }

  async function withPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !preview) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    if (password !== String(data.get("repeat"))) return setError("The passwords differ.");
    setPending(true);
    setError(null);
    const res = await browserApi.invitations["accept-password"].$post({
      json: { token, name: String(data.get("name")), password },
    });
    if (!res.ok) {
      setPending(false);
      return setError((await readError(res)).error);
    }
    const signIn = await authClient.signIn.email({ email: preview.email, password });
    setPending(false);
    if (signIn.error) return setError(signIn.error.message ?? "Joined, but signing in failed: sign in again.");
    joined();
  }

  async function signOut() {
    await authClient.signOut();
    setSignedInAs(null);
    // The header is a server component: re-render it signed out.
    router.refresh();
  }

  return (
    <main className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">{preview ? `Join ${preview.tenantName}` : "Invitation"}</h1>
      {preview && (
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          You're invited as <span className="font-medium">{preview.role}</span>, as {preview.email}. The link works
          until {new Date(preview.expiresAt).toLocaleDateString()}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {preview && signedInAs && (
        <div className="mt-6 space-y-3">
          {signedInAs.toLowerCase() === preview.email ? (
            <button type="button" disabled={pending} onClick={() => void accept()} className={button}>
              {pending ? "Joining…" : `Join as ${signedInAs}`}
            </button>
          ) : (
            <p className="text-sm">
              You're signed in as {signedInAs}, but this invitation is for {preview.email}.{" "}
              <button type="button" className="underline" onClick={() => void signOut()}>
                Sign out
              </button>{" "}
              and open the link again.
            </p>
          )}
        </div>
      )}

      {preview && signedInAs === null && (
        <div className="mt-6 space-y-4">
          {preview.google && <GoogleButton returnTo="/invite" errorTo="/invite" onError={setError} />}
          {preview.acceptWith === "google_or_password" && (
            <form onSubmit={withPassword} className="space-y-4">
              {preview.google && <p className="text-center text-xs text-neutral-500">or choose a password</p>}
              <label className="block text-sm font-medium">
                Your name
                <input name="name" required autoComplete="name" className={input} />
              </label>
              <label className="block text-sm font-medium">
                Password (12+ characters)
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                  className={input}
                />
              </label>
              <label className="block text-sm font-medium">
                Repeat it
                <input
                  name="repeat"
                  type="password"
                  minLength={12}
                  required
                  autoComplete="new-password"
                  className={input}
                />
              </label>
              <button type="submit" disabled={pending} className={button}>
                {pending ? "Joining…" : "Join"}
              </button>
            </form>
          )}
          <p className="text-center text-xs text-neutral-500">
            Already have an account?{" "}
            <Link href="/sign-in?next=/invite" className="underline">
              Sign in
            </Link>{" "}
            and you'll come back here.
          </p>
        </div>
      )}
    </main>
  );
}
