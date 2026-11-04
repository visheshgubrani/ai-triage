"use client";

import type { SetupStatusResponse } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const field = "w-full rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700";

/**
 * The one-time setup form. The token comes in the URL's fragment (`/setup#<token>`, printed in the
 * api's log), which never reaches a server log or a Referer.
 */
export function SetupView() {
  const [status, setStatus] = useState<SetupStatusResponse | null>(null);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState("");
  const [acceptWith, setAcceptWith] = useState<"google" | "google_or_password">("google_or_password");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setToken(window.location.hash.slice(1));
    void (async () => {
      const res = await browserApi.setup.status.$get();
      if (res.ok) setStatus(await res.json());
    })();
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await browserApi.setup.$post({
        json: { token, workspaceName: name, slug, adminEmail: email, acceptWith },
      });
      if (!res.ok) return setError((await readError(res)).error);
      const { inviteUrl } = (await res.json()) as { inviteUrl: string };
      window.location.assign(inviteUrl);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="mt-6 text-sm text-neutral-500">Loading…</p>;
  if (!status.needed) {
    return (
      <p className="mt-6 text-sm">
        Setup is done: a workspace exists.{" "}
        <a className="underline" href="/sign-in">
          Sign in
        </a>
        , or ask an admin for an invitation.
      </p>
    );
  }
  if (!token) {
    return (
      <p className="mt-6 text-sm text-red-600">
        This page needs the setup link from the api's log (<code>/setup#…</code>). Find it with{" "}
        <code>docker compose logs api | grep setup</code>, or print a new one with <code>pnpm setup-link</code>.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <label className="block text-sm">
        Workspace name
        <input
          required
          className={field}
          value={name}
          placeholder="Acme Inc."
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugOf(e.target.value));
          }}
        />
      </label>
      <label className="block text-sm">
        Short name (in URLs and CLIs)
        <input
          required
          className={field}
          value={slug}
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
      </label>
      <label className="block text-sm">
        Admin's email
        <input required type="email" className={field} value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <fieldset className="text-sm">
        <legend>The admin signs in with</legend>
        {status.googleSignIn && (
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" checked={acceptWith === "google"} onChange={() => setAcceptWith("google")} /> Google
            only
          </label>
        )}
        <label className="mt-1 flex items-center gap-2">
          <input
            type="radio"
            checked={acceptWith === "google_or_password"}
            onChange={() => setAcceptWith("google_or_password")}
          />{" "}
          {status.googleSignIn ? "Google or a password" : "A password"}
        </label>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "Creating…" : "Create the workspace"}
      </Button>
    </form>
  );
}
