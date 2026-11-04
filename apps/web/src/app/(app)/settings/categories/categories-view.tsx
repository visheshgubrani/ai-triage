"use client";

import type { CategoryDefinitionInput, CategoryInfo, CategoryList, CategoryPreview } from "@ai-triage/contracts";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { Field } from "@/components/field";
import { LoadingBlock } from "@/components/loading";
import { type Message, Notice, ResultNotice } from "@/components/notice";
import { Section } from "@/components/section";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

/** `support_request` → "Support request", for a built-in, which has no label of its own. */
const humanize = (name: string) => name.charAt(0).toUpperCase() + name.slice(1).replaceAll("_", " ");

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
    <div className="space-y-2 rounded-lg bg-muted/50 p-3">
      <p className="text-xs font-medium text-muted-foreground">Columns of each row</p>
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity until named
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Column name"
            className="w-36 bg-card font-mono"
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
            className="min-w-48 flex-1 bg-card"
            value={it.description}
            placeholder="What it holds"
            onChange={(e) => set(i, { description: e.target.value })}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <Checkbox checked={it.required ?? false} onCheckedChange={(v) => set(i, { required: v === true })} />
            Required
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
      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...items, { name: "", type: "text", description: "" }])}
      >
        <Plus aria-hidden="true" />
        Add column
      </Button>
    </div>
  );
}

type Options = Pick<CategoryList, "fieldTypes" | "comparators">;

function FieldRow({
  field,
  index,
  count,
  options,
  onChange,
  onMove,
  onRemove,
}: {
  field: FieldDraft;
  index: number;
  count: number;
  options: Options;
  onChange: (f: FieldDraft) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const set = (patch: Partial<FieldDraft>) => onChange({ ...field, ...patch });
  const scalar = !["boolean", "text_list", "object_list"].includes(field.type);
  return (
    <li className="flex gap-3 px-4 py-3.5">
      <span className="mt-1.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
      <div className="min-w-0 flex-1 space-y-2">
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
            Required
          </label>
          {scalar && (
            <label
              className="flex cursor-pointer items-center gap-1.5 text-xs"
              title="The value must be backed by a verbatim quote from the document"
            >
              <Checkbox checked={field.quote ?? false} onCheckedChange={(v) => set({ quote: v === true })} />
              Needs a quote
            </label>
          )}
          <span className="ml-auto flex gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onMove(-1)}
              disabled={index === 0}
              aria-label="Move up"
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onMove(1)}
              disabled={index === count - 1}
              aria-label="Move down"
            >
              <ArrowDown aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:text-danger"
              onClick={onRemove}
              aria-label="Remove field"
            >
              <Trash2 aria-hidden="true" />
            </Button>
          </span>
        </div>
        <Input
          aria-label="Field description"
          value={field.description}
          placeholder="What the model should put here, in one line"
          onChange={(e) => set({ description: e.target.value })}
        />
        {field.type === "enum" && (
          <Input
            aria-label="Allowed values"
            className="font-mono"
            value={(field.enum ?? []).join(", ")}
            placeholder="Allowed values: value_a, value_b, value_c"
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
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight
              aria-hidden="true"
              className="size-3 transition-transform group-data-[state=open]:rotate-90"
            />
            Advanced
          </CollapsibleTrigger>
          <CollapsibleContent>
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
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
          </CollapsibleContent>
        </Collapsible>
      </div>
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
        `Saved ${body.category} v${body.version}. Pipeline version ${body.config.version} is active, with every category reviewed by a person.`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="-ml-2" onClick={onCancel}>
          <ChevronLeft aria-hidden="true" />
          All categories
        </Button>
        <span aria-hidden="true" className="text-muted-foreground/60">
          /
        </span>
        <h2 className="text-sm font-semibold">
          {editing
            ? `Edit ${initial.label ?? initial.name}`
            : initial.name
              ? `New from ${initial.label ?? initial.name}`
              : "New category"}
        </h2>
      </div>

      <Section title="Details" className="mt-3">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" hint="Lowercase with underscores. It's the category in the API and webhooks.">
            <Input
              className="font-mono"
              value={draft.name}
              placeholder="receipt"
              disabled={editing}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <Field label="Label" hint="Optional: the name people see.">
            <Input
              value={draft.label ?? ""}
              placeholder="Receipt"
              onChange={(e) => setDraft({ ...draft, label: e.target.value || undefined })}
            />
          </Field>
          <Field
            label="Description"
            hint="One line. The classifier reads it to recognize this type."
            className="sm:col-span-2"
          >
            <Input
              value={draft.description}
              placeholder="Proof of a payment already made"
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </Field>
          <Field
            label="Examples"
            hint="Optional: up to 3 sample subjects or openings, one per line."
            className="sm:col-span-2"
          >
            <Textarea
              className="font-mono"
              rows={3}
              value={(draft.examples ?? []).join("\n")}
              onChange={(e) => setDraft({ ...draft, examples: e.target.value.split("\n").filter((l) => l.trim()) })}
            />
          </Field>
        </div>
      </Section>

      <Section
        flush
        title={
          <>
            Fields <span className="font-normal text-muted-foreground tabular-nums">{fields.length}</span>
          </>
        }
        description="What to extract, in the order reviewers see it."
      >
        <ol className="divide-y divide-border">
          {fields.map((f, i) => (
            <FieldRow
              // biome-ignore lint/suspicious/noArrayIndexKey: fields have no identity until named
              key={i}
              field={f}
              index={i}
              count={fields.length}
              options={options}
              onChange={(next) => setFields(fields.map((x, k) => (k === i ? next : x)))}
              onMove={(by) => setFields(move(fields, i, by))}
              onRemove={() => setFields(fields.filter((_, k) => k !== i))}
            />
          ))}
        </ol>
        <div className="border-t p-3">
          <Button
            variant="ghost"
            className="w-full border border-dashed border-border text-muted-foreground"
            onClick={() => setFields([...fields, { name: "", type: "text", description: "" }])}
          >
            <Plus aria-hidden="true" />
            Add field
          </Button>
        </div>
      </Section>

      {preview && preview.issues.length > 0 && (
        <Notice tone="danger" role="alert" className="mt-6">
          <p className="font-medium">Fix these before saving</p>
          <ul className="mt-1 space-y-0.5">
            {preview.issues.map((i) => (
              <li key={`${i.path}:${i.message}`}>
                <code className="text-xs">{i.path}</code> {i.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {warnings.length > 0 && (
        <Notice tone="warning" className="mt-6">
          <ul className="space-y-1">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      )}
      {preview?.jsonSchema && (
        <Collapsible className="mt-4">
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
            <ChevronRight
              aria-hidden="true"
              className="size-4 transition-transform group-data-[state=open]:rotate-90"
            />
            Compiled JSON Schema
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(preview.jsonSchema, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="sticky bottom-0 z-10 mt-6 -mb-6 flex flex-wrap items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
        {error && (
          <p role="alert" className="mr-auto text-sm text-danger">
            {error}
          </p>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => void check()}>Check</Button>
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          Save and activate
        </Button>
      </div>
    </div>
  );
}

function CategoryRow({ c, onEdit, onRemove }: { c: CategoryInfo; onEdit: () => void; onRemove: () => void }) {
  const auto = c.automation === "auto_when_confident";
  return (
    <li className="flex gap-4 px-4 py-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{c.definition?.label ?? humanize(c.category)}</span>
          <code className="text-xs text-muted-foreground">{c.category}</code>
          <Pill tone={c.origin === "builtin" ? "neutral" : "accent"}>
            {c.origin === "builtin" ? "Built-in" : `Custom v${c.version}`}
          </Pill>
          <Pill
            dot
            tone={auto ? "success" : "neutral"}
            title={auto ? "Approved without a person when the score clears its threshold" : undefined}
          >
            {auto ? "Auto-approves" : "Human review"}
          </Pill>
        </div>
        <p className="mt-1 text-muted-foreground">{c.description}</p>
        <ul aria-label="Fields" className="mt-2.5 flex flex-wrap gap-1">
          {c.fields.map((f) => (
            <li
              key={f.name}
              className="inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 font-mono text-[11px] text-muted-foreground"
            >
              {f.required && <span aria-hidden="true" className="size-1 rounded-full bg-primary" />}
              {f.name}
              {f.required && <span className="sr-only">(required)</span>}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-start gap-0.5">
        {c.definition && (
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil aria-hidden="true" />
            Edit
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-danger"
          onClick={onRemove}
          aria-label={`Remove ${c.category}`}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

/** A way to start a category: a template, or a blank one. Named by its title alone (the e2e clicks "Receipt"). */
function StarterCard({
  id,
  title,
  detail,
  meta,
  blank = false,
  onClick,
}: {
  id: string;
  title: string;
  detail: string;
  meta?: string;
  blank?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-describedby={`starter-${id}`}
      onClick={onClick}
      className={
        blank
          ? "flex flex-col items-start gap-1 rounded-lg border border-dashed p-3 text-left transition-colors outline-none hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50"
          : "flex flex-col items-start gap-1 rounded-lg border bg-background p-3 text-left transition-colors outline-none hover:border-primary/50 hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/10"
      }
    >
      <span className="flex items-center gap-1.5 font-medium">
        {blank && <Plus aria-hidden="true" className="size-4 text-primary" />}
        {title}
      </span>
      <span id={`starter-${id}`} className="line-clamp-2 text-xs text-muted-foreground">
        {detail}
      </span>
      {meta && <span className="mt-auto pt-1 text-xs text-muted-foreground/80">{meta}</span>}
    </button>
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
  const [message, setMessage] = useState<Message | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.categories.$get();
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setList(await res.json());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!list) return message ? <ResultNotice message={message} /> : <LoadingBlock />;

  function edit(draft: Draft, existing: boolean) {
    setMessage(null);
    setEditing({ draft, existing });
    window.scrollTo({ top: 0 });
  }

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

  if (editing) {
    return (
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
          window.scrollTo({ top: 0 });
          await load();
        }}
      />
    );
  }

  const used = new Set(list.categories.map((c) => c.category));
  const starters = list.starters.filter((s) => !used.has(s.id));
  const atLimit = list.categories.length >= list.limits.categoriesPerTenant;

  return (
    <>
      <ResultNotice message={message} />
      <Notice className="mt-6">
        Every document is sorted into one of these automatically; one that fits none is{" "}
        <code className="text-xs">other</code> and goes to review. Auto-approval is turned on per category from a{" "}
        <Link href="/evals" className="font-medium text-foreground underline-offset-2 hover:underline">
          calibrated eval
        </Link>
        .
      </Notice>

      <Section
        flush
        title={
          <>
            Active categories{" "}
            <span className="font-normal text-muted-foreground tabular-nums">{list.categories.length}</span>
          </>
        }
        description={
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-primary" />
            marks a required field
          </span>
        }
      >
        <ul className="divide-y divide-border">
          {list.categories.map((c) => (
            <CategoryRow
              key={c.category}
              c={c}
              onEdit={() => c.definition && edit(c.definition as Draft, true)}
              onRemove={() => void remove(c.category)}
            />
          ))}
        </ul>
      </Section>

      <Section
        title="Add a category"
        description="Start from a template and adjust it, or from scratch. Custom categories pass the same gates as built-ins, without code rules."
      >
        {atLimit ? (
          <p className="text-muted-foreground">
            A workspace has at most {list.limits.categoriesPerTenant} categories. Remove one to add another.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <StarterCard
              id="blank"
              blank
              title="Blank category"
              detail="Name it, describe it, and list its fields yourself."
              onClick={() => edit(blank(), false)}
            />
            {starters.map((s) => (
              <StarterCard
                key={s.id}
                id={s.id}
                title={s.title}
                detail={s.definition.description}
                meta={`${s.definition.fields.length} fields`}
                onClick={() => edit(s.definition, false)}
              />
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
