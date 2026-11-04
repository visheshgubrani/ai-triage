"use client";

import type { CategoryDefinitionInput, CategoryInfo, CategoryList, CategoryPreview } from "@ai-triage/contracts";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { LoadingBlock } from "@/components/loading";
import { FormMessage } from "@/components/notice";
import { Section } from "@/components/section";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

type Draft = CategoryDefinitionInput;
type FieldDraft = Draft["fields"][number];
type ItemDraft = NonNullable<FieldDraft["itemFields"]>[number];

const ITEM_TYPES = ["text", "number", "amount", "date", "boolean"] as const;
const TYPE_LABELS: Record<CategoryList["fieldTypes"][number], string> = {
  text: "text",
  long_text: "long text",
  number: "number",
  amount: "amount",
  date: "date",
  email: "email",
  enum: "one of a list",
  boolean: "yes / no",
  text_list: "list of text",
  object_list: "list of rows",
};

const blank = (): Draft => ({
  name: "",
  description: "",
  examples: [],
  fields: [{ name: "", type: "text", description: "", required: true }],
});

/** Moves element i of a list by `by` places (for the field builder's up and down buttons). */
function move<T>(list: T[], i: number, by: number): T[] {
  const j = i + by;
  if (j < 0 || j >= list.length) return list;
  const next = [...list];
  [next[i], next[j]] = [next[j] as T, next[i] as T];
  return next;
}

function ItemFields({ items, onChange }: { items: ItemDraft[]; onChange: (items: ItemDraft[]) => void }) {
  const set = (i: number, patch: Partial<ItemDraft>) =>
    onChange(items.map((it, k) => (k === i ? { ...it, ...patch } : it)));
  return (
    <div className="mt-2 space-y-1.5 border-l-2 pl-3">
      <p className="text-xs text-muted-foreground">Columns of each row</p>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Column name"
            className="w-36 font-mono"
            value={it.name}
            placeholder="column_name"
            onChange={(e) => set(i, { name: e.target.value })}
          />
          <NativeSelect
            aria-label="Column type"
            value={it.type}
            onChange={(e) => set(i, { type: e.target.value as ItemDraft["type"] })}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Column description"
            className="min-w-48 flex-1"
            value={it.description}
            placeholder="What it holds"
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox checked={it.required ?? false} onCheckedChange={(v) => set(i, { required: v === true })} />
            required
          </label>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Remove column"
            onClick={() => onChange(items.filter((_, k) => k !== i))}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...items, { name: "", type: "text", description: "" }])}>
        <Plus aria-hidden="true" />
        Add column
      </Button>
    </div>
  );
}

type Options = Pick<CategoryList, "fieldTypes" | "comparators">;

function FieldRow({
  field,
  options,
  onChange,
  onMove,
  onRemove,
}: {
  field: FieldDraft;
  options: Options;
  onChange: (f: FieldDraft) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<FieldDraft>) => onChange({ ...field, ...patch });
  const scalar = !["boolean", "text_list", "object_list"].includes(field.type);
  return (
    <li className="rounded-lg border bg-background p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Field name"
          className="w-44 font-mono"
          value={field.name}
          placeholder="field_name"
          onChange={(e) => set({ name: e.target.value })}
        />
        <NativeSelect
          aria-label="Field type"
          value={field.type}
          onChange={(e) => {
            const type = e.target.value as FieldDraft["type"];
            set({
              type,
              quote: ["boolean", "text_list", "object_list"].includes(type) ? false : field.quote,
              enum: type === "enum" ? (field.enum ?? []) : undefined,
              itemFields:
                type === "object_list"
                  ? (field.itemFields ?? [{ name: "", type: "text", description: "" }])
                  : undefined,
            });
          }}
        >
          {options.fieldTypes.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </NativeSelect>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <Checkbox checked={field.required ?? false} onCheckedChange={(v) => set({ required: v === true })} />
          required
        </label>
        {scalar && (
          <label
            className="flex cursor-pointer items-center gap-1.5 text-xs"
            title="The value must be backed by a verbatim quote"
          >
            <Checkbox checked={field.quote ?? false} onCheckedChange={(v) => set({ quote: v === true })} />
            needs a quote
          </label>
        )}
        <span className="ml-auto flex gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove field">
            <Trash2 aria-hidden="true" />
          </Button>
        </span>
      </div>
      <Input
        aria-label="Field description"
        className="mt-2 w-full"
        value={field.description}
        placeholder="What the model should put here, in one line"
        onChange={(e) => set({ description: e.target.value })}
      />
      {field.type === "enum" && (
        <Input
          aria-label="Allowed values"
          className="mt-2 w-full font-mono"
          value={(field.enum ?? []).join(", ")}
          placeholder="value_a, value_b, value_c"
          onChange={(e) =>
            set({
              enum: e.target.value
                .split(",")
                .map((v) => v.trim())
                .filter(Boolean),
            })
          }
        />
      )}
      {field.type === "object_list" && (
        <ItemFields items={field.itemFields ?? []} onChange={(itemFields) => set({ itemFields })} />
      )}
      <details className="group mt-2 text-xs text-muted-foreground">
        <summary className="w-fit select-none hover:text-foreground">Advanced</summary>
        <label className="mt-1.5 flex items-center gap-2">
          Eval comparator
          <NativeSelect
            size="sm"
            value={field.comparator ?? ""}
            onChange={(e) => set({ comparator: (e.target.value || undefined) as FieldDraft["comparator"] })}
          >
            <option value="">default for the type</option>
            {options.comparators.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </NativeSelect>
        </label>
      </details>
    </li>
  );
}

function Editor({
  initial,
  options,
  editing,
  warnings,
  onSaved,
  onCancel,
}: {
  initial: Draft;
  options: Options;
  editing: boolean;
  warnings: string[];
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const confirm = useConfirm();
  const [draft, setDraft] = useState<Draft>(initial);
  const [preview, setPreview] = useState<CategoryPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fields = draft.fields;
  const setFields = (next: FieldDraft[]) => setDraft({ ...draft, fields: next });

  async function check() {
    const res = await browserApi.categories.preview.$post({ json: draft } as never);
    const body = (await res.json()) as CategoryPreview;
    setPreview(body);
    return body;
  }

  async function save() {
    setError(null);
    const checked = await check();
    if (checked.issues.length > 0) return;
    if (
      warnings.length > 0 &&
      !(await confirm({ title: "Save and activate?", body: warnings.join("\n\n"), confirm: "Save anyway" }))
    )
      return;
    setBusy(true);
    try {
      const res = await browserApi.categories.$post({ json: draft as never });
      if (!res.ok) return setError((await readError(res)).error);
      const body = await res.json();
      onSaved(
        `Saved ${body.category} v${body.version}; version ${body.config.version} of the pipeline is active, with every category reviewed by a person.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title={editing ? `Edit ${initial.name}` : "New category"}>
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label="Category name"
            className="w-56 font-mono"
            value={draft.name}
            placeholder="category_name"
            disabled={editing}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Input
            aria-label="Label"
            className="flex-1"
            value={draft.label ?? ""}
            placeholder="Label (optional)"
            onChange={(e) => setDraft({ ...draft, label: e.target.value || undefined })}
          />
        </div>
        <Input
          aria-label="Category description"
          className="w-full"
          value={draft.description}
          placeholder="What it is, so the classifier can recognize it (one line)"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <Textarea
          aria-label="Examples"
          className="w-full font-mono"
          rows={2}
          value={(draft.examples ?? []).join("\n")}
          placeholder="Up to 3 sample subjects or openings, one per line (optional)"
          onChange={(e) => setDraft({ ...draft, examples: e.target.value.split("\n").filter((l) => l.trim()) })}
        />
        <ol className="space-y-2">
          {fields.map((f, i) => (
            <FieldRow
              // biome-ignore lint/suspicious/noArrayIndexKey: fields have no identity until named
              key={i}
              field={f}
              options={options}
              onChange={(next) => setFields(fields.map((x, k) => (k === i ? next : x)))}
              onMove={(by) => setFields(move(fields, i, by))}
              onRemove={() => setFields(fields.filter((_, k) => k !== i))}
            />
          ))}
        </ol>
        <Button onClick={() => setFields([...fields, { name: "", type: "text", description: "" }])}>
          <Plus aria-hidden="true" />
          Add field
        </Button>
        {preview && preview.issues.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-sm text-danger">
            {preview.issues.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <span className="font-mono">{i.path}</span> {i.message}
              </li>
            ))}
          </ul>
        )}
        {preview?.jsonSchema && (
          <details className="text-xs">
            <summary className="w-fit text-muted-foreground select-none hover:text-foreground">JSON Schema</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3">
              {JSON.stringify(preview.jsonSchema, null, 2)}
            </pre>
          </details>
        )}
        {warnings.map((w) => (
          <p key={w} className="text-xs text-warning">
            {w}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button variant="primary" onClick={save} disabled={busy}>
            Save and activate
          </Button>
          <Button onClick={check}>Check</Button>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </div>
    </Section>
  );
}

function CategoryRow({ c, onEdit, onRemove }: { c: CategoryInfo; onEdit: () => void; onRemove: () => void }) {
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono font-medium">{c.category}</span>
        <span className="text-xs text-muted-foreground">
          {c.origin === "builtin" ? "built-in, with rules" : `custom v${c.version}`} ·{" "}
          {c.automation === "auto_when_confident" ? "auto-approves when confident" : "a person reviews"}
        </span>
        <span className="ml-auto flex gap-1">
          {c.definition && (
            <Button variant="ghost" size="xs" onClick={onEdit}>
              Edit
            </Button>
          )}
          <Button variant="ghost" size="xs" onClick={onRemove}>
            Remove
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{c.description}</p>
      <p className="mt-1 font-mono text-xs text-muted-foreground">
        {c.fields.map((f) => (f.required ? `${f.name}*` : f.name)).join(", ")}
      </p>
    </li>
  );
}

/**
 * The document types the pipeline sorts into. Built-ins are code (with arithmetic and date rules);
 * custom ones are definitions saved here. Any change makes a new pipeline version in which every
 * category is reviewed by a person, and activates it.
 */
export function CategoriesView() {
  const confirm = useConfirm();
  const [list, setList] = useState<CategoryList | null>(null);
  const [editing, setEditing] = useState<{ draft: Draft; existing: boolean } | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.categories.$get();
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setList(await res.json());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!list) return message ? <p className="text-sm text-danger">{message.text}</p> : <LoadingBlock />;

  async function remove(name: string) {
    const extra = list?.warnings.length ? `\n\n${list.warnings.join("\n\n")}` : "";
    if (
      !(await confirm({
        title: `Remove ${name}?`,
        body: `Documents already extracted keep their fields.${extra}`,
        confirm: "Remove category",
        destructive: true,
      }))
    )
      return;
    const res = await browserApi.categories[":name"].$delete({ param: { name } });
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setMessage({ error: false, text: `Removed ${name}.` });
    await load();
  }

  const used = new Set(list.categories.map((c) => c.category));
  const atLimit = list.categories.length >= list.limits.categoriesPerTenant;

  return (
    <div className="space-y-2">
      <Section title={`Active categories (${list.categories.length})`}>
        <ul className="divide-y divide-border">
          {list.categories.map((c) => (
            <CategoryRow
              key={c.category}
              c={c}
              onEdit={() => c.definition && setEditing({ draft: c.definition as Draft, existing: true })}
              onRemove={() => remove(c.category)}
            />
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground">
          * required. Anything that fits none of these is classified as <span className="font-mono">other</span> and
          goes to review.
        </p>
      </Section>

      <FormMessage message={message} />

      {editing ? (
        <Editor
          key={`${editing.draft.name}:${editing.existing}`}
          initial={editing.draft}
          options={list}
          editing={editing.existing}
          warnings={list.warnings}
          onCancel={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setMessage({ error: false, text });
            await load();
          }}
        />
      ) : (
        <Section title="Add a category">
          {atLimit ? (
            <p className="text-muted-foreground">
              A workspace has at most {list.limits.categoriesPerTenant} categories.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => setEditing({ draft: blank(), existing: false })}>
                Blank
              </Button>
              {list.starters
                .filter((s) => !used.has(s.id))
                .map((s) => (
                  <Button key={s.id} onClick={() => setEditing({ draft: s.definition, existing: false })}>
                    {s.title}
                  </Button>
                ))}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Start from a template and edit it, or from scratch. Custom categories have no code rules; the gates (schema,
            required fields, quotes, confidence) apply as for built-ins.
          </p>
        </Section>
      )}
    </div>
  );
}
