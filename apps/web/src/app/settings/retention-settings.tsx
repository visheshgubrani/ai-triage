"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

/** How long finished documents are kept before the daily purge deletes them. */
export function RetentionSettingsView() {
  const [days, setDays] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

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
    <Section title="Retention">
      <p className="text-neutral-600 dark:text-neutral-400">
        Finished documents (decided and delivered) older than this are deleted every night, with their files,
        extractions and review history. Copies in eval sets are kept. Empty keeps everything.
      </p>
      <form onSubmit={save} className="mt-3 flex flex-wrap items-center gap-2">
        <label htmlFor="retention-days">Keep for (days)</label>
        <input
          id="retention-days"
          type="number"
          min="1"
          step="1"
          placeholder="forever"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          className="w-32 rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700"
        />
        <Button type="submit" variant="primary">
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
    </Section>
  );
}
