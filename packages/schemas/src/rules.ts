import { getTemplate } from "./templates";
import type { FieldValues } from "./types";
import { dropNulls } from "./validate";

export interface RuleResult {
  id: string;
  passed: boolean;
  description: string;
}

/** Runs the built-in rules of a category version. Rules that don't apply are left out. */
export function runCategoryRules(category: string, version: number, values: FieldValues): RuleResult[] {
  const rules = getTemplate(category, version)?.rules ?? [];
  const clean = dropNulls(values);
  return rules.flatMap((rule) => {
    const passed = rule.check(clean);
    return passed === undefined ? [] : [{ id: rule.id, passed, description: rule.description }];
  });
}
