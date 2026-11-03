"use client";

import type { FieldMarks } from "@ai-triage/core/review";
import { humanize } from "@/lib/format";
import { type EvidenceCheck, type FieldSchema, typeOf } from "./gates";

type Values = Record<string, unknown>;

const INPUT =
  "w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm disabled:opacity-70 dark:border-neutral-700";

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
      <select
        id={id}
        aria-label={label}
        className={INPUT}
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
      </select>
    );
  }
  if (type === "boolean") {
    return (
      <select
        id={id}
        aria-label={label}
        className={INPUT}
        disabled={readOnly}
        value={value === true ? "true" : value === false ? "false" : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}
      >
        <option value="">-</option>
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    );
  }
  if (type === "number" || type === "integer") {
    return (
      <input
        id={id}
        aria-label={label}
        type="number"
        step={type === "integer" ? 1 : "any"}
        className={`${INPUT} font-mono`}
        disabled={readOnly}
        value={typeof value === "number" ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    );
  }
  // Dates stay text inputs, so a malformed date the model wrote is shown (and fixed), not dropped.
  return (
    <input
      id={id}
      aria-label={label}
      type={field.format === "email" ? "email" : "text"}
      placeholder={field.format === "date" ? "YYYY-MM-DD" : undefined}
      className={INPUT}
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
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-neutral-500">
          <tr>
            {columns.map(([name]) => (
              <th key={name} className="pr-2 pb-1 font-medium">
                {humanize(name)}
                {required.has(name) && <span className="text-red-600">*</span>}
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
                <td key={name} className="pr-2 pb-1">
                  <ScalarInput
                    field={col}
                    label={`${label} ${i + 1} ${name}`}
                    value={row[name]}
                    readOnly={readOnly}
                    onChange={(v) => setRow(i, { ...row, [name]: v })}
                  />
                </td>
              ))}
              <td className="pb-1">
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={`Remove row ${i + 1}`}
                    className="px-1 text-neutral-500 hover:text-red-600"
                    onClick={() => onChange(rows.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button
          type="button"
          className="mt-1 text-xs text-neutral-600 underline underline-offset-2 dark:text-neutral-400"
          onClick={() => onChange([...rows, Object.fromEntries(columns.map(([name]) => [name, null]))])}
        >
          Add row
        </button>
      )}
    </div>
  );
}

function EvidenceTag({ check, onClick }: { check?: EvidenceCheck; onClick: () => void }) {
  if (!check) return null;
  const [text, tone] =
    check.status === "verified"
      ? [check.page ? `quote · p. ${check.page}` : "quote", "text-emerald-700 dark:text-emerald-400"]
      : check.status === "not_found"
        ? ["quote not found", "text-red-700 dark:text-red-400"]
        : ["no quote", "text-amber-700 dark:text-amber-400"];
  return (
    <button type="button" onClick={onClick} className={`font-normal underline-offset-2 hover:underline ${tone}`}>
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
    <div className="space-y-3">
      {Object.entries(schema.properties ?? {}).map(([name, field]) => {
        const id = `field-${name}`;
        const fieldMarks = marks.byField[name] ?? [];
        const isRows = typeOf(field) === "array" && typeOf(field.items ?? {}) === "object";
        const set = (v: unknown) => onChange({ ...values, [name]: v });
        return (
          <div
            key={name}
            onFocusCapture={() => onFocus(name)}
            className={`rounded-md p-2 ${focus === name ? "bg-amber-50 ring-1 ring-amber-300 dark:bg-amber-950/40 dark:ring-amber-800" : ""} ${fieldMarks.length ? "border-l-2 border-red-400 pl-3" : ""}`}
          >
            <div className="mb-1 flex flex-wrap items-baseline gap-2 text-xs font-medium">
              <label htmlFor={isRows ? undefined : id}>
                {humanize(name)}
                {required.has(name) && <span className="text-red-600">*</span>}
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
              <p key={m} className="mt-1 text-xs text-red-700 dark:text-red-400">
                {m}
              </p>
            ))}
            {field.description && <p className="mt-1 text-xs text-neutral-500">{field.description}</p>}
          </div>
        );
      })}
    </div>
  );
}
