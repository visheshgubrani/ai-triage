"use client";

import type { ApiKeySummary } from "@ai-triage/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

const input = "rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700";

/** Keys for the REST API (`POST /v1/documents`). A new key is shown once; only its prefix is kept. */
export function ApiKeysView() {
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.settings["api-keys"].$get();
    if (!res.ok) return setMessage((await readError(res)).error);
    setKeys((await res.json()).keys);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const days = Number(data.get("days"));
    const res = await browserApi.settings["api-keys"].$post({
      json: { name: String(data.get("name")), ...(days > 0 ? { expiresInDays: days } : {}) },
    });
    if (!res.ok) return setMessage((await readError(res)).error);
    setCreated((await res.json()).key);
    form.reset();
    await load();
  }

  async function revoke(key: ApiKeySummary) {
    if (!window.confirm(`Revoke ${key.name} (${key.prefix}…)? Clients using it stop working at once.`)) return;
    const res = await browserApi.settings["api-keys"][":id"].revoke.$post({ param: { id: key.id } });
    if (!res.ok) return setMessage((await readError(res)).error);
    await load();
  }

  const state = (k: ApiKeySummary) =>
    k.revokedAt ? "revoked" : k.expiresAt && new Date(k.expiresAt) < new Date() ? "expired" : "active";

  return (
    <Section title="API keys">
      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <input name="name" placeholder="Name, e.g. ERP export" required maxLength={100} className={input} />
        <select name="days" className={input} defaultValue="90" aria-label="Expires">
          <option value="30">Expires in 30 days</option>
          <option value="90">Expires in 90 days</option>
          <option value="365">Expires in a year</option>
          <option value="0">Never expires</option>
        </select>
        <Button type="submit" variant="primary">
          Create
        </Button>
      </form>
      {created && (
        <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <p className="text-amber-900 dark:text-amber-200">Copy this key now; it won't be shown again.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-neutral-900">
              {created}
            </code>
            <Button onClick={() => void navigator.clipboard.writeText(created)}>Copy</Button>
          </div>
        </div>
      )}
      {message && (
        <p role="alert" className="mt-2 text-red-600">
          {message}
        </p>
      )}
      <table className="mt-3 w-full text-left text-xs">
        <thead className="text-neutral-500">
          <tr>
            <th className="py-1 pr-2 font-medium">Name</th>
            <th className="py-1 pr-2 font-medium">Key</th>
            <th className="py-1 pr-2 font-medium">Last used</th>
            <th className="py-1 pr-2 font-medium">Expires</th>
            <th className="py-1 font-medium" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id} className="border-t border-neutral-100 dark:border-neutral-900">
              <td className="py-1 pr-2">{k.name}</td>
              <td className="py-1 pr-2 font-mono">{k.prefix}…</td>
              <td className="py-1 pr-2">{k.lastUsedAt ? ago(k.lastUsedAt) : "never"}</td>
              <td className="py-1 pr-2">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "never"}</td>
              <td className="py-1 text-right">
                {state(k) === "active" ? <Button onClick={() => void revoke(k)}>Revoke</Button> : state(k)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
