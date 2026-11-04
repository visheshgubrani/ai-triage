"use client";

import type { SetupStatusResponse } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Field } from "@/components/field";
import { LoadingBlock } from "@/components/loading";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

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

  if (!status) return <LoadingBlock />;
  if (!status.needed) {
    return (
      <p className="mt-6 text-sm">
        Setup is done: a workspace exists.{" "}
        <a className="font-medium text-primary underline-offset-2 hover:underline" href="/sign-in">
          Sign in
        </a>
        , or ask an admin for an invitation.
      </p>
    );
  }
  if (!token) {
    return (
      <p className="mt-6 text-sm text-danger">
        This page needs the setup link from the api's log (<code>/setup#…</code>). Find it with{" "}
        <code>docker compose logs api | grep setup</code>, or print a new one with <code>pnpm setup-link</code>.
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <Field label="Workspace name">
        <Input
          required
          value={name}
          placeholder="Acme Inc."
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugOf(e.target.value));
          }}
        />
      </Field>
      <Field label="Short name (in URLs and CLIs)">
        <Input
          required
          value={slug}
          pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]"
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value);
          }}
        />
      </Field>
      <Field label="Admin's email">
        <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <fieldset className="text-sm">
        <legend className="font-medium">The admin signs in with</legend>
        <RadioGroup
          className="mt-2"
          value={acceptWith}
          onValueChange={(value) => setAcceptWith(value as typeof acceptWith)}
        >
          {status.googleSignIn && (
            <label className="flex cursor-pointer items-center gap-2">
              <RadioGroupItem value="google" /> Google only
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-2">
            <RadioGroupItem value="google_or_password" /> {status.googleSignIn ? "Google or a password" : "A password"}
          </label>
        </RadioGroup>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="primary" disabled={busy} className="w-full">
        {busy ? "Creating…" : "Create the workspace"}
      </Button>
    </form>
  );
}
