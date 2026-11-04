"use client";

import type { ApiKeySummary } from "@ai-triage/contracts";
import { KeyRound, Plus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Field, ToggleRow } from "@/components/field";
import { LoadingBlock } from "@/components/loading";
import { FormMessage } from "@/components/notice";
import { SecretReveal } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";

const stateOf = (k: ApiKeySummary) =>
  k.revokedAt ? "revoked" : k.expiresAt && new Date(k.expiresAt) < new Date() ? "expired" : "active";

/** Name, expiry and scope of a new key. The key itself comes back once, to the page. */
function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (key: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const days = Number(data.get("days"));
    const scopes: ApiKeySummary["scopes"] = data.get("read") ? ["ingest", "read"] : ["ingest"];
    setBusy(true);
    try {
      const res = await browserApi.settings["api-keys"].$post({
        json: { name: String(data.get("name")), scopes, ...(days > 0 ? { expiresInDays: days } : {}) },
      });
      if (!res.ok) return setError((await readError(res)).error);
      setError(null);
      await onCreated((await res.json()).key);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>The key is shown once, right after you create it.</DialogDescription>
          </DialogHeader>
          <Field label="Name" hint="What uses it, so you know what breaks if you revoke it.">
            <Input name="name" placeholder="ERP export" required maxLength={100} autoComplete="off" />
          </Field>
          <Field label="Expires">
            <NativeSelect name="days" defaultValue="90" className="w-full">
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="0">Never</option>
            </NativeSelect>
          </Field>
          <ToggleRow
            label="Can read documents"
            detail="Leave it off for a scanner or mail relay that only sends documents in."
            control={<Checkbox name="read" defaultChecked />}
          />
          <FormMessage message={error ? { error: true, text: error } : null} className="mt-0" />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Keys for the REST API (docs/api.md). A new key is shown once; only its prefix is kept. A key that
 * only sends documents in (a scanner, a mail relay) can leave out reading them back.
 */
export function ApiKeysView() {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.settings["api-keys"].$get();
    if (!res.ok) return setMessage((await readError(res)).error);
    setKeys((await res.json()).keys);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

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

  if (!keys) return message ? <FormMessage message={{ error: true, text: message }} /> : <LoadingBlock />;

  const active = keys.filter((k) => stateOf(k) === "active");
  const inactive = keys.length - active.length;
  const shown = showInactive ? keys : active;
  const createButton = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <Plus aria-hidden="true" />
      Create key
    </Button>
  );

  return (
    <>
      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (key) => {
          setCreating(false);
          setCreated(key);
          await load();
        }}
      />
      <Section
        title={
          <>
            Keys <span className="font-normal text-muted-foreground tabular-nums">{active.length}</span>
          </>
        }
        actions={keys.length > 0 && createButton}
        footer={
          inactive > 0 && (
            <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setShowInactive((s) => !s)}>
              {showInactive ? "Hide" : "Show"} {inactive} revoked or expired
            </Button>
          )
        }
      >
        {created && <SecretReveal value={created}>Copy this key now; it won't be shown again.</SecretReveal>}
        <FormMessage message={message ? { error: true, text: message } : null} />
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            description="Create one to send documents from a scanner, a mail relay or your own code."
            action={createButton}
          />
        ) : shown.length === 0 ? (
          <p className="py-4 text-center text-muted-foreground">No active keys.</p>
        ) : (
          <DataTable className={cn(created && "mt-3")}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Access</th>
                <th>Last used</th>
                <th>Expires</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((k) => {
                const state = stateOf(k);
                return (
                  <tr key={k.id} className={cn(state !== "active" && "text-muted-foreground")}>
                    <td className="font-medium">{k.name}</td>
                    <td className="font-mono text-xs text-muted-foreground">{k.prefix}…</td>
                    <td>
                      <Pill tone={k.scopes.includes("read") ? "info" : "neutral"}>
                        {k.scopes.includes("read") ? "Send + read" : "Send"}
                      </Pill>
                    </td>
                    <td className="whitespace-nowrap">{k.lastUsedAt ? ago(k.lastUsedAt) : "Never"}</td>
                    <td className="whitespace-nowrap">
                      {k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "Never"}
                    </td>
                    <td className="text-right">
                      {state === "active" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-danger"
                          onClick={() => void revoke(k)}
                        >
                          Revoke
                        </Button>
                      ) : (
                        <Pill>{state === "revoked" ? "Revoked" : "Expired"}</Pill>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        )}
      </Section>
    </>
  );
}
