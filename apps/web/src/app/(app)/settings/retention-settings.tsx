"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { FormMessage, type Message } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** How long finished documents are kept before the daily purge deletes them. */
export function RetentionSettingsView() {
  const [days, setDays] = useState("");
  const [message, setMessage] = useState<Message | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await browserApi.settings.retention.$get();
      if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
      const { retentionDays } = await res.json();
      setDays(retentionDays ? String(retentionDays) : "");
    })();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    const value = days.trim() === "" ? null : Number(days);
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      return setMessage({ error: true, text: "Enter a whole number of days, or leave it empty." });
    }
    const res = await browserApi.settings.retention.$put({ json: { retentionDays: value } });
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setMessage({
      error: false,
      text: value ? `Finished documents older than ${value} days will be deleted daily.` : "Documents are kept.",
    });
  }

  return (
    <Section
      flush
      title="Retention"
      footer={
        <>
          {message ? (
            <FormMessage message={message} className="mt-0 mr-auto" />
          ) : (
            <SectionHint>Copies in eval sets are kept.</SectionHint>
          )}
          <Button type="submit" form="retention-form" variant="primary">
            Save
          </Button>
        </>
      }
    >
      <SettingRows>
        <SettingRow
          label="Delete finished documents after"
          htmlFor="retention-days"
          hint="Decided and delivered ones, with their files and review history. Empty keeps everything."
        >
          <form id="retention-form" onSubmit={save}>
            <InputGroup className="w-40">
              <InputGroupInput
                id="retention-days"
                type="number"
                min="1"
                step="1"
                placeholder="Forever"
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="tabular-nums"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText>days</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </SettingRow>
      </SettingRows>
    </Section>
  );
}
