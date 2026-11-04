"use client";

import type { ApiKeySummary } from "@ai-triage/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { SecretReveal } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

/**
 * Keys for the REST API (docs/api.md). A new key is shown once; only its prefix is kept. A key that
 * only sends documents in (a scanner, a mail relay) can leave out reading them back.
 */
export function ApiKeysView() {
  const confirm = useConfirm();
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
    const scopes: ApiKeySummary["scopes"] = data.get("read") ? ["ingest", "read"] : ["ingest"];
    const res = await browserApi.settings["api-keys"].$post({
      json: { name: String(data.get("name")), scopes, ...(days > 0 ? { expiresInDays: days } : {}) },
    });
    if (!res.ok) return setMessage((await readError(res)).error);
    setCreated((await res.json()).key);
    form.reset();
    await load();
  }

  async function revoke(key: ApiKeySummary) {
    if (
      !(await confirm({
        title: `Revoke ${key.name} (${key.prefix}…)?`,
        body: "Clients using it stop working at once.",
        confirm: "Revoke key",
        destructive: true,
      }))
    )
      return;
    const res = await browserApi.settings["api-keys"][":id"].revoke.$post({ param: { id: key.id } });
    if (!res.ok) return setMessage((await readError(res)).error);
    await load();
  }

  const state = (k: ApiKeySummary) =>
    k.revokedAt ? "revoked" : k.expiresAt && new Date(k.expiresAt) < new Date() ? "expired" : "active";

  return (
    <Section
      title="API keys"
      description="For the REST API: each key sends documents, and can also read them if allowed."
    >
      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <Input name="name" placeholder="Name, e.g. ERP export" required maxLength={100} className="w-56" />
        <NativeSelect name="days" defaultValue="90" aria-label="Expires">
          <option value="30">Expires in 30 days</option>
          <option value="90">Expires in 90 days</option>
          <option value="365">Expires in a year</option>
          <option value="0">Never expires</option>
        </NativeSelect>
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox name="read" defaultChecked />
          Can read documents
        </label>
        <Button type="submit" variant="primary">
          Create
        </Button>
      </form>
      {created && <SecretReveal value={created}>Copy this key now; it won't be shown again.</SecretReveal>}
      {message && (
        <p role="alert" className="mt-2 text-danger">
          {message}
        </p>
      )}
      <DataTable>
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Can</th>
            <th>Last used</th>
            <th>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>{k.name}</td>
              <td className="font-mono">{k.prefix}…</td>
              <td>{k.scopes.includes("read") ? "send, read" : "send"}</td>
              <td>{k.lastUsedAt ? ago(k.lastUsedAt) : "never"}</td>
              <td>{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "never"}</td>
              <td className="text-right">
                {state(k) === "active" ? (
                  <Button size="sm" variant="danger" onClick={() => void revoke(k)}>
                    Revoke
                  </Button>
                ) : (
                  <span className="text-muted-foreground">{state(k)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </Section>
  );
}
