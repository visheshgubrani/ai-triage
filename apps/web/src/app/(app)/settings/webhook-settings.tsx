"use client";

import type { WebhookSettings } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { FormMessage } from "@/components/notice";
import { SecretReveal } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { Input } from "@/components/ui/input";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** The tenant's webhook target and signing secret. The secret is shown once, when created or rotated. */
export function WebhookSettingsView() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.settings.webhook.$get();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      const s = await res.json();
      setSettings(s);
      setUrl(s.url ?? "");
    })();
  }, []);

  /** A signed `ping`, exactly as deliveries are signed: the receiver's answer shows here. */
  async function sendTest() {
    setBusy(true);
    try {
      const res = await browserApi.settings.webhook.test.$post();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      const result = await res.json();
      setMessage(
        result.ok
          ? { error: false, text: `Test event delivered: HTTP ${result.status} in ${result.ms} ms.` }
          : { error: true, text: `Test event failed: ${result.error} (${result.ms} ms).` },
      );
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await browserApi.settings.webhook.$put({ json: { url: url.trim() || null } });
      if (!res.ok) {
        const err = await readError(res);
        return setMessage({ error: true, text: err.issues?.[0]?.message ?? err.error });
      }
      const body = await res.json();
      setSettings(body.settings);
      if (body.secret) setSecret(body.secret);
      setMessage({ error: false, text: "Saved." });
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (
      !(await confirm({
        title: "Rotate the signing secret?",
        body: "The old one keeps working for 24 hours.",
        confirm: "Rotate secret",
      }))
    )
      return;
    const res = await browserApi.settings.webhook.rotate.$post();
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    const body = await res.json();
    setSettings(body.settings);
    setSecret(body.secret);
    setMessage({ error: false, text: "Secret rotated." });
  }

  return (
    <>
      <Section title="Webhook">
        <p className="text-muted-foreground">
          Every approved document is POSTed here as JSON, signed with the secret below. Deliveries go only to this URL.
        </p>
        <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="webhook-url" className="sr-only">
            Webhook URL
          </label>
          <Input
            id="webhook-url"
            type="url"
            placeholder="https://example.com/hooks/triage"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="min-w-64 flex-1"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
        </form>
        <FormMessage message={message} />
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span>
            Signing secret:{" "}
            <span className="font-mono">
              {settings?.secretSet ? settings.secretHint : "not set (created with the first URL)"}
            </span>
          </span>
          {settings?.secretSet && <Button onClick={() => void rotate()}>Rotate</Button>}
          {settings?.url && settings.secretSet && (
            <Button onClick={() => void sendTest()} disabled={busy}>
              Send test event
            </Button>
          )}
        </div>
        {settings?.previousSecretValidUntil && (
          <p className="mt-2 text-muted-foreground">
            Deliveries are also signed with the previous secret until{" "}
            {new Date(settings.previousSecretValidUntil).toLocaleString()}, so receivers can switch over.
          </p>
        )}
        {secret && <SecretReveal value={secret}>Copy this secret now; it won't be shown again.</SecretReveal>}
      </Section>
      <Section title="Receiver contract">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Headers: <code>Idempotency-Key</code> (the action id), <code>X-Triage-Event: document.approved</code> and{" "}
            <code>X-Triage-Signature: t=&lt;unix&gt;,v2=&lt;hex&gt;</code> (one <code>v2</code> per secret during a
            rotation).
          </li>
          <li>
            Verify: HMAC-SHA256 of <code>&lt;t&gt;.&lt;Idempotency-Key&gt;.&lt;raw body&gt;</code> with your secret
            equals any <code>v2</code>, and <code>t</code> is within 5 minutes.
          </li>
          <li>Webhook URLs must be public https; private receivers need the operator's WEBHOOK_ALLOWED_HOSTS.</li>
          <li>Delivery is at least once: dedupe on the Idempotency-Key. Answer 2xx to accept.</li>
          <li>
            5xx, 408, 425, 429, timeouts and network errors are retried with backoff; other 4xx and redirects fail at
            once.
          </li>
        </ul>
      </Section>
    </>
  );
}
