"use client";

import type { FieldMarks } from "@ai-triage/core/review";
import { Check, Plus, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { humanize } from "@/lib/format";
import { type EvidenceCheck, type FieldSchema, typeOf } from "./gates";

type Values = Record<string, unknown>;

/** One scalar input for a schema node. Empty input means null (the field is absent). */
function ScalarInput({
  field,
  value,
  onChange,
  readOnly,
  id,
  label,
}: {
  field: FieldSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly: boolean;
  id?: string;
  label: string;
}) {
  const type = typeOf(field);
  if (field.enum) {
    return (
      <NativeSelect
        className="w-full"
        id={id}
        aria-label={label}
        disabled={readOnly}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">-</option>
        {field.enum.map((v) => (
          <option key={String(v)} value={String(v)}>
            {String(v)}
          </option>
        ))}
      </NativeSelect>
    );
  }
  if (type === "boolean") {
    return (
      <NativeSelect
        className="w-full"
        id={id}
        aria-label={label}
        disabled={readOnly}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
      >
        <option value="">-</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </NativeSelect>
    );
  }
  if (type === "number" || type === "integer") {
    return (
      <Input
        id={id}
        aria-label={label}
        type="number"
        step={type === "integer" ? 1 : "any"}
        className="font-mono"
        disabled={readOnly}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  }
  // A list of plain values (tags, parties' names): one per line, so an edit saves a real list.
  if (type === "array") {
    const itemType = typeOf(field.items ?? {});
    const lines = Array.isArray(value) ? value.map((v) => String(v)) : [];
    return (
      <Textarea
        id={id}
        aria-label={`${label}, one per line`}
        rows={Math.max(2, lines.length + 1)}
        disabled={readOnly}
        value={lines.join("\n")}
        onChange={(e) => {
          const items = e.target.value
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          onChange(itemType === "number" || itemType === "integer" ? items.map(Number) : items);
        }}
      />
    );
  }
  // Dates stay text inputs, so a malformed date the model wrote is shown (and fixed), not dropped.
  return (
    <Input
      id={id}
      aria-label={label}
      type={field.format === "email" ? "email" : "text"}
      placeholder={field.format === "date" ? "YYYY-MM-DD" : undefined}
      disabled={readOnly}
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
    />
  );
}

/** An array of objects (invoice line items, contract parties) as editable rows. */
function RowsInput({
  field,
  value,
  onChange,
  readOnly,
  label,
}: {
  field: FieldSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly: boolean;
  label: string;
}) {
  const rows = Array.isArray(value) ? (value as Values[]) : [];
  const columns = Object.entries(field.items?.properties ?? {});
  const required = new Set(field.items?.required ?? []);
  const setRow = (i: number, row: Values) => onChange(rows.map((r, j) => (j === i ? row : r)));
  return (
    <div>
      <DataTable plain>
        <thead>
          <tr>
            {columns.map(([name]) => (
              <th key={name}>
                {humanize(name)}
                {required.has(name) && <span className="text-danger"> *</span>}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own
            <tr key={i}>
              {columns.map(([name, col]) => (
                <td key={name}>
                  <ScalarInput
                    field={col}
                    label={`${label} ${i + 1} ${name}`}
                    value={row[name]}
                    readOnly={readOnly}
                    onChange={(v) => setRow(i, { ...row, [name]: v })}
                  />
                </td>
              ))}
              <td>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove row ${i + 1}`}
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {!readOnly && (
        <Button
          size="sm"
          className="mt-1"
          onClick={() => onChange([...rows, Object.fromEntries(columns.map(([name]) => [name, null]))])}
        >
          <Plus aria-hidden="true" />
          Add row
        </Button>
      )}
    </div>
  );
}

function EvidenceTag({ check, onClick }: { check?: EvidenceCheck; onClick: () => void }) {
  if (!check) return null;
  const [text, tone, Icon] =
    check.status === "verified"
      ? [check.page ? `quote · p. ${check.page}` : "quote", "text-success", Check]
      : check.status === "not_found"
        ? ["quote not found", "text-danger", TriangleAlert]
        : ["no quote", "text-warning", TriangleAlert];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 font-normal underline-offset-2 hover:underline ${tone}`}
    >
      <Icon aria-hidden="true" className="size-3" />
      {text}
    </button>
  );
}

/**
 * The extraction as a form rendered from its category's JSON Schema. Gate failures and server-side
 * validation issues are shown on their fields; clicking a field's evidence tag shows its quote.
 */
export function FieldForm({
  schema,
  values,
  onChange,
  readOnly,
  marks,
  checks,
  focus,
  onFocus,
}: {
  schema: FieldSchema;
  values: Values;
  onChange: (values: Values) => void;
  readOnly: boolean;
  marks: FieldMarks;
  checks: Map<string, EvidenceCheck>;
  focus: string | null;
  onFocus: (field: string) => void;
}) {
  const required = new Set(schema.required ?? []);
  return (
    <div className="-mx-2 space-y-1">
      {Object.entries(schema.properties ?? {}).map(([name, field]) => {
        const id = `field-${name}`;
        const fieldMarks = marks.byField[name] ?? [];
        const isRows = typeOf(field) === "array" && typeOf(field.items ?? {}) === "object";
        const set = (v: unknown) => onChange({ ...values, [name]: v });
        return (
          <div
            key={name}
            onFocusCapture={() => onFocus(name)}
            className={`rounded-lg p-2 transition-colors ${focus === name ? "bg-accent/60" : ""} ${fieldMarks.length ? "border-l-2 border-danger pl-3" : ""}`}
          >
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs font-medium">
              <label htmlFor={isRows ? undefined : id}>
                {humanize(name)}
                {required.has(name) && <span className="text-danger">*</span>}
              </label>
              <EvidenceTag check={checks.get(name)} onClick={() => onFocus(name)} />
            </div>
            {isRows ? (
              <RowsInput field={field} value={values[name]} onChange={set} readOnly={readOnly} label={humanize(name)} />
            ) : (
              <ScalarInput
                id={id}
                field={field}
                label={humanize(name)}
                value={values[name]}
                onChange={set}
                readOnly={readOnly}
              />
            )}
            {fieldMarks.map((m) => (
              <p key={m} className="mt-1 text-xs text-danger">
                {m}
              </p>
            ))}
            {field.description && <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>}
          </div>
        );
      })}
    </div>
  );
}
