import type { z } from "zod";

/**
 * Attaches a description (shown to the model) and, with `quote`, the `x-evidence` flag: a non-null
 * value must cite a verbatim quote that the evidence gate can find in the source.
 */
export function field<T extends z.ZodType>(schema: T, description: string, opts: { quote?: boolean } = {}): T {
  return schema.meta(opts.quote ? { description, "x-evidence": true } : { description });
}

/** Absolute tolerance for comparing amounts in rules. */
export const CENT = 0.01;

export const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
export const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
