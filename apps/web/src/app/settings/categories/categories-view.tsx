"use client";

import type { CategoryDefinitionInput, CategoryInfo, CategoryList, CategoryPreview } from "@ai-triage/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";

type Draft = CategoryDefinitionInput;
type FieldDraft = Draft["fields"][number];
type ItemDraft = NonNullable<FieldDraft["itemFields"]>[number];

const input = "rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm dark:border-neutral-700";
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
    <div className="mt-2 space-y-1 border-l-2 border-neutral-200 pl-3 dark:border-neutral-800">
      <p className="text-xs text-neutral-500">Columns of each row</p>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named
        <div key={i} className="flex flex-wrap items-center gap-2">
          <input
            aria-label="Column name"
            className={`${input} w-36 font-mono`}
            value={it.name}
            placeholder="column_name"
            onChange={(e) => set(i, { name: e.target.value })}
          />
          <select
            aria-label="Column type"
            className={input}
            value={it.type}
            onChange={(e) => set(i, { type: e.target.value as ItemDraft["type"] })}
          >
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            aria-label="Column description"
            className={`${input} min-w-48 flex-1`}
            value={it.description}
            placeholder="What it holds"
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={it.required ?? false}
              onChange={(e) => set(i, { required: e.target.checked })}
            />
            required
          </label>
          <button type="button" className="text-xs underline" onClick={() => onChange(items.filter((_, k) => k !== i))}>
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="text-xs underline"
        onClick={() => onChange([...items, { name: "", type: "text", description: "" }])}
      >
        Add column
      </button>
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
    <li className="rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Field name"
          className={`${input} w-44 font-mono`}
          value={field.name}
          placeholder="field_name"
          onChange={(e) => set({ name: e.target.value })}
        />
        <select
          aria-label="Field type"
          className={input}
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
        </select>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={field.required ?? false}
            onChange={(e) => set({ required: e.target.checked })}
          />
          required
        </label>
        {scalar && (
          <label className="flex items-center gap-1 text-xs" title="The value must be backed by a verbatim quote">
            <input type="checkbox" checked={field.quote ?? false} onChange={(e) => set({ quote: e.target.checked })} />
            needs a quote
          </label>
        )}
        <span className="ml-auto flex gap-2 text-xs">
          <button type="button" className="underline" onClick={() => onMove(-1)} aria-label="Move up">
            ↑
          </button>
          <button type="button" className="underline" onClick={() => onMove(1)} aria-label="Move down">
            ↓
          </button>
          <button type="button" className="underline" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <input
        aria-label="Field description"
        className={`${input} mt-2 w-full`}
        value={field.description}
        placeholder="What the model should put here, in one line"
        onChange={(e) => set({ description: e.target.value })}
      />
      {field.type === "enum" && (
        <input
          aria-label="Allowed values"
          className={`${input} mt-2 w-full font-mono`}
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
      <details className="mt-2 text-xs text-neutral-500">
        <summary>Advanced</summary>
        <label className="mt-1 flex items-center gap-2">
          Eval comparator
          <select
            className={input}
            value={field.comparator ?? ""}
            onChange={(e) => set({ comparator: (e.target.value || undefined) as FieldDraft["comparator"] })}
          >
            <option value="">default for the type</option>
            {options.comparators.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
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
    if (warnings.length > 0 && !window.confirm(`${warnings.join("\n\n")}\n\nSave and activate?`)) return;
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
          <input
            aria-label="Category name"
            className={`${input} w-56 font-mono`}
            value={draft.name}
            placeholder="category_name"
            disabled={editing}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <input
            aria-label="Label"
            className={`${input} flex-1`}
            value={draft.label ?? ""}
            placeholder="Label (optional)"
            onChange={(e) => setDraft({ ...draft, label: e.target.value || undefined })}
          />
        </div>
        <input
          aria-label="Category description"
          className={`${input} w-full`}
          value={draft.description}
          placeholder="What it is, so the classifier can recognize it (one line)"
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <textarea
          aria-label="Examples"
          className={`${input} w-full font-mono text-xs`}
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
        <Button onClick={() => setFields([...fields, { name: "", type: "text", description: "" }])}>Add field</Button>
        {preview && preview.issues.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-sm text-red-600">
            {preview.issues.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <span className="font-mono">{i.path}</span> {i.message}
              </li>
            ))}
          </ul>
        )}
        {preview?.jsonSchema && (
          <details className="text-xs">
            <summary className="cursor-pointer text-neutral-500">JSON Schema</summary>
            <pre className="mt-2 max-h-80 overflow-auto rounded bg-neutral-50 p-2 dark:bg-neutral-900">
              {JSON.stringify(preview.jsonSchema, null, 2)}
            </pre>
          </details>
        )}
        {warnings.map((w) => (
          <p key={w} className="text-xs text-amber-700 dark:text-amber-400">
            {w}
          </p>
        ))}
        {error && (
          <p role="alert" className="text-sm text-red-600">
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
        <span className="text-xs text-neutral-500">
          {c.origin === "builtin" ? "built-in, with rules" : `custom v${c.version}`} ·{" "}
          {c.automation === "auto_when_confident" ? "auto-approves when confident" : "a person reviews"}
        </span>
        <span className="ml-auto flex gap-3 text-xs">
          {c.definition && (
            <button type="button" className="underline" onClick={onEdit}>
              Edit
            </button>
          )}
          <button type="button" className="underline" onClick={onRemove}>
            Remove
          </button>
        </span>
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">{c.description}</p>
      <p className="mt-1 font-mono text-xs text-neutral-500">
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

  if (!list)
    return message ? (
      <p className="text-sm text-red-600">{message.text}</p>
    ) : (
      <p className="text-sm text-neutral-500">Loading…</p>
    );

  async function remove(name: string) {
    const extra = list?.warnings.length ? `\n\n${list.warnings.join("\n\n")}` : "";
    if (!window.confirm(`Remove ${name}? Documents already extracted keep their fields.${extra}`)) return;
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
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-800">
          {list.categories.map((c) => (
            <CategoryRow
              key={c.category}
              c={c}
              onEdit={() => c.definition && setEditing({ draft: c.definition as Draft, existing: true })}
              onRemove={() => remove(c.category)}
            />
          ))}
        </ul>
        <p className="mt-2 text-xs text-neutral-500">
          * required. Anything that fits none of these is classified as <span className="font-mono">other</span> and
          goes to review.
        </p>
      </Section>

      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`text-sm ${message.error ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
        >
          {message.text}
        </p>
      )}

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
            <p className="text-neutral-500">A workspace has at most {list.limits.categoriesPerTenant} categories.</p>
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
          <p className="mt-3 text-xs text-neutral-500">
            Start from a template and edit it, or from scratch. Custom categories have no code rules; the gates (schema,
            required fields, quotes, confidence) apply as for built-ins.
          </p>
        </Section>
      )}
    </div>
  );
}
