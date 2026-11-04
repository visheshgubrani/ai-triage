"use client";

import type { WebhookSettings } from "@ai-triage/contracts";
import { RotateCw, Send } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { FormMessage, type Message } from "@/components/notice";
import { SecretReveal } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { Input } from "@/components/ui/input";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 text-xs">{children}</code>;
}

/** What a receiver gets and must do (docs/api.md), as reference beside the settings. */
const CONTRACT: { term: string; detail: ReactNode }[] = [
  {
    term: "Headers",
    detail: (
      <>
        <Code>Idempotency-Key</Code> (the action id), <Code>X-Triage-Event: document.approved</Code>,{" "}
        <Code>X-Triage-Signature: t=&lt;unix&gt;,v2=&lt;hex&gt;</Code>
      </>
    ),
  },
  {
    term: "Verify",
    detail: (
      <>
        HMAC-SHA256 of <Code>&lt;t&gt;.&lt;Idempotency-Key&gt;.&lt;raw body&gt;</Code> equals any <Code>v2</Code>, and{" "}
        <Code>t</Code> is within 5 minutes. A rotation sends one <Code>v2</Code> per secret.
      </>
    ),
  },
  { term: "Delivery", detail: "At least once: dedupe on the Idempotency-Key, and answer 2xx to accept." },
  {
    term: "Retries",
    detail: "5xx, 408, 425, 429, timeouts and network errors, with backoff. Other 4xx and redirects fail at once.",
  },
  {
    term: "Hosts",
    detail: (
      <>
        Public https only. Private receivers need the operator's <Code>WEBHOOK_ALLOWED_HOSTS</Code>.
      </>
    ),
  },
];

/** The tenant's webhook target and signing secret. The secret is shown once, when created or rotated. */
export function WebhookSettingsView() {
  const confirm = useConfirm();
  const [settings, setSettings] = useState<WebhookSettings | null>(null);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
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

  const previousUntil = settings?.previousSecretValidUntil;
  return (
    <>
      <Section
        flush
        title="Endpoint"
        description="Every approved document is POSTed here as JSON, signed with the secret."
        footer={
          <>
            {message && <FormMessage message={message} className="mt-0 mr-auto" />}
            {settings?.url && settings.secretSet && (
              <Button onClick={() => void sendTest()} disabled={busy}>
                <Send aria-hidden="true" />
                Send test event
              </Button>
            )}
            <Button type="submit" form="webhook-form" variant="primary" disabled={busy}>
              Save
            </Button>
          </>
        }
      >
        <SettingRows>
          <SettingRow label="URL" htmlFor="webhook-url" hint="Deliveries go only here. Empty turns them off.">
            <form id="webhook-form" onSubmit={save} className="w-full">
              <Input
                id="webhook-url"
                type="url"
                placeholder="https://example.com/hooks/triage"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </form>
          </SettingRow>
          <SettingRow
            label="Signing secret"
            hint={
              previousUntil
                ? `The previous secret also signs until ${new Date(previousUntil).toLocaleString()}.`
                : "Shown once, when it's created or rotated."
            }
          >
            {settings?.secretSet ? (
              <>
                <code className="rounded-md bg-muted px-2 py-1 text-xs">{settings.secretHint}</code>
                <Button variant="ghost" onClick={() => void rotate()}>
                  <RotateCw aria-hidden="true" />
                  Rotate
                </Button>
              </>
            ) : (
              <span className="text-muted-foreground">Created with the first URL</span>
            )}
          </SettingRow>
        </SettingRows>
        {secret && (
          <div className="px-4 pb-4">
            <SecretReveal value={secret}>Copy this secret now; it won't be shown again.</SecretReveal>
          </div>
        )}
      </Section>

      <Section title="Receiver contract" description="What your endpoint receives, and how to check it came from here.">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
          {CONTRACT.map((c) => (
            <div key={c.term} className="contents">
              <dt className="font-medium">{c.term}</dt>
              <dd className="text-muted-foreground">{c.detail}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </>
  );
}
