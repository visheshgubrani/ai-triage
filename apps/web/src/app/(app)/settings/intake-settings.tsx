"use client";

import type { IntakeSettings } from "@ai-triage/contracts";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { FormMessage, type Message } from "@/components/notice";
import { CopyField } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

const FILTERS: { key: keyof IntakeSettings; label: string; hint: string; headers: string }[] = [
  {
    key: "auto_replies",
    label: "Skip auto-replies",
    hint: "Out-of-office and other automatic answers.",
    headers: "Auto-Submitted, X-Autoreply, Precedence: auto_reply",
  },
  {
    key: "bounces",
    label: "Skip bounces",
    hint: "Delivery failures and read receipts.",
    headers: "Content-Type: multipart/report",
  },
  {
    key: "bulk",
    label: "Skip bulk and list mail",
    hint: "Newsletters and mailing lists. Some vendors send invoices this way.",
    headers: "List-Id, List-Unsubscribe, Precedence: bulk",
  },
];

/**
 * Email intake: the address mail is forwarded to (anyone who knows it can send documents in, so it
 * can be replaced), and which kinds of automatic mail end as `skipped` before any model call
 * (headers only, never content).
 */
export function IntakeSettingsView() {
  const confirm = useConfirm();
  const [addresses, setAddresses] = useState<string[] | null>(null);
  const [filters, setFilters] = useState<IntakeSettings | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    void (async () => {
      const [inbound, intake] = await Promise.all([
        browserApi.settings.inbound.$get(),
        browserApi.settings.intake.$get(),
      ]);
      if (!inbound.ok) return setMessage({ error: true, text: (await readError(inbound)).error });
      if (!intake.ok) return setMessage({ error: true, text: (await readError(intake)).error });
      setAddresses((await inbound.json()).addresses);
      setFilters(await intake.json());
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

  async function toggle(key: keyof IntakeSettings) {
    if (!filters) return;
    const next = { ...filters, [key]: !filters[key] };
    const res = await browserApi.settings.intake.$put({ json: next });
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setFilters(next);
    setMessage({ error: false, text: "Saved. It applies to mail that arrives from now on." });
  }

  return (
    <Section
      flush
      title="Email intake"
      description={
        <>
          Skipped mail never reaches the model. Find it under{" "}
          <Link href="/documents" className="font-medium text-foreground underline-offset-2 hover:underline">
            Documents → Skipped
          </Link>
          .
        </>
      }
      footer={message && <FormMessage message={message} className="mt-0 mr-auto" />}
    >
      <SettingRows>
        <SettingRow label="Forwarding address" hint="Mail sent here is triaged. Replace it if it leaks.">
          {addresses === null ? (
            <Skeleton className="h-8 w-full md:max-w-xs" />
          ) : addresses.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            addresses.map((a) => <CopyField key={a} value={a} className="w-full md:max-w-xs" />)
          )}
          <Button variant="ghost" onClick={() => void rotate()}>
            <RefreshCw aria-hidden="true" />
            Replace
          </Button>
        </SettingRow>
        {FILTERS.map((f) => (
          <SettingRow
            key={f.key}
            label={f.label}
            hint={f.hint}
            info={`Matched by headers: ${f.headers}`}
            htmlFor={`intake-${f.key}`}
          >
            {filters ? (
              <Switch id={`intake-${f.key}`} checked={filters[f.key]} onCheckedChange={() => void toggle(f.key)} />
            ) : (
              <Skeleton className="h-[18px] w-8 rounded-full" />
            )}
          </SettingRow>
        ))}
      </SettingRows>
    </Section>
  );
}
