import type { CategoryTemplate } from "../types";
import { contract } from "./contract";
import { invoice } from "./invoice";
import { supportRequest } from "./support-request";

/** Built-in category templates, keyed by category. Keys must match BUILTIN_CATEGORIES in core. */
export const TEMPLATES: Readonly<Record<string, CategoryTemplate>> = {
  [invoice.category]: invoice,
  [supportRequest.category]: supportRequest,
  [contract.category]: contract,
};

/** The template a stored schema version came from, or undefined for custom categories (later). */
export function getTemplate(category: string, version: number): CategoryTemplate | undefined {
  const template = TEMPLATES[category];
  return template?.version === version ? template : undefined;
}
