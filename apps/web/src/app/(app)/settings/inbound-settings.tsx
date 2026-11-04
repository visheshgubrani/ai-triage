"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { FormMessage } from "@/components/notice";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** The address mail is forwarded to. Anyone who knows it can send documents in, so it can be rotated. */
export function InboundSettingsView() {
  const confirm = useConfirm();
  const [addresses, setAddresses] = useState<string[] | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.settings.inbound.$get();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      setAddresses((await res.json()).addresses);
    })();
  }, []);

  async function rotate() {
    if (
      !(await confirm({
        title: "Replace the inbound address?",
        body: "Mail sent to the old one will be ignored.",
        confirm: "Replace address",
        destructive: true,
      }))
    )
      return;
    const res = await browserApi.settings.inbound.rotate.$post();
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setAddresses((await res.json()).addresses);
    setMessage({ error: false, text: "New address created. Update your forwarding rule." });
  }

  return (
    <Section title="Inbound email">
      <p className="text-muted-foreground">
        Forward mail to this address to triage it. Anyone who knows it can send documents in; replace it if it leaks.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <code className="font-mono">{addresses === null ? "…" : addresses.join(", ") || "none"}</code>
        <Button onClick={() => void rotate()}>Replace</Button>
      </div>
      <FormMessage message={message} />
    </Section>
  );
}
