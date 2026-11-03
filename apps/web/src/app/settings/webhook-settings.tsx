"use client";

import type { WebhookSettings } from "@ai-triage/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** The tenant's webhook target and signing secret. The secret is shown once, when created or rotated. */
export function WebhookSettingsView() {
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
    if (!window.confirm("Rotate the signing secret? Receivers must switch to the new one.")) return;
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
        <p className="text-neutral-600 dark:text-neutral-400">
          Every approved document is POSTed here as JSON, signed with the secret below. Deliveries go only to this URL.
        </p>
        <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="webhook-url" className="sr-only">
            Webhook URL
          </label>
          <input
            id="webhook-url"
            type="url"
            placeholder="https://example.com/hooks/triage"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="min-w-64 flex-1 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
          />
          <Button type="submit" variant="primary" disabled={busy}>
            Save
          </Button>
        </form>
        {message && (
          <p
            role={message.error ? "alert" : "status"}
            className={`mt-2 ${message.error ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
          >
            {message.text}
          </p>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span>
            Signing secret:{" "}
            <span className="font-mono">
              {settings?.secretSet ? settings.secretHint : "not set (created with the first URL)"}
            </span>
          </span>
          {settings?.secretSet && <Button onClick={() => void rotate()}>Rotate</Button>}
        </div>
        {secret && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-amber-900 dark:text-amber-200">Copy this secret now; it won't be shown again.</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-neutral-900">
                {secret}
              </code>
              <Button onClick={() => void navigator.clipboard.writeText(secret)}>Copy</Button>
            </div>
          </div>
        )}
      </Section>
      <Section title="Receiver contract">
        <ul className="list-disc space-y-1 pl-5 text-neutral-600 dark:text-neutral-400">
          <li>
            Headers: <code>Idempotency-Key</code> (the action id), <code>X-Triage-Event: document.approved</code> and{" "}
            <code>X-Triage-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code>.
          </li>
          <li>
            Verify: HMAC-SHA256 of <code>&lt;t&gt;.&lt;raw body&gt;</code> with the secret equals <code>v1</code>, and{" "}
            <code>t</code> is within 5 minutes.
          </li>
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
