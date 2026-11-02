/** The Postgres SQLSTATE of an error, looking through drizzle's DrizzleQueryError wrapper. */
export function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  while (e && typeof e === "object") {
    if ("code" in e && typeof e.code === "string") return e.code;
    e = "cause" in e ? e.cause : undefined;
  }
  return undefined;
}

export const PG = {
  checkViolation: "23514",
  foreignKeyViolation: "23503",
  uniqueViolation: "23505",
  notNullViolation: "23502",
  integrityViolation: "23000",
  rlsViolation: "42501",
} as const;
