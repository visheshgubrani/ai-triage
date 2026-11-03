/** Token counts by price class. `input` excludes cache writes and reads. */
export interface Usage {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** A provider's response, reduced to what the gateway records and reads. */
export interface NormalizedResponse {
  /** `end_turn`, `max_tokens` or `refusal` (Claude's names, mapped from the others); anything else is unexpected. */
  stopReason: string;
  refusalCategory: string | null;
  /** The structured output as returned, before JSON parsing. */
  text: string | null;
  usage: Usage;
  /** Claude server-side fallback hops, each priced at its own model; empty otherwise. */
  hops: (Usage & { model: string | null })[];
  servedByFallback: boolean;
}
