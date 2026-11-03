import type { ErrorResponse, Issue } from "@ai-triage/contracts";
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";

/** Zod issues as the API reports them: the top-level field, a JSON pointer, and the message. */
export function toIssues(error: { issues: readonly z.core.$ZodIssue[] }): Issue[] {
  return error.issues.map((i) => ({
    field: String(i.path[0] ?? ""),
    path: `/${i.path.map(String).join("/")}`,
    message: i.message,
  }));
}

/** zValidator with the ErrorResponse shape: 400 `{ error, issues }` (the default hook returns Zod's raw result). */
export function validate<Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const body: ErrorResponse = { error: "Invalid request", issues: toIssues(result.error) };
      return c.json(body, 400);
    }
  });
}
