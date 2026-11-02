import { createHash } from "node:crypto";

/** Bump to invalidate every cassette on purpose (for example, after changing the cassette format). */
export const CASSETTE_FORMAT = 1;

/** JSON with object keys sorted at every level, so equal params always serialize the same way. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );
}

/** The cassette key of a request: SHA-256 of its canonical params plus the cassette format. */
export function requestHash(params: unknown): string {
  return createHash("sha256")
    .update(`cassette-v${CASSETTE_FORMAT}\n${canonicalJson(params)}`)
    .digest("hex");
}
