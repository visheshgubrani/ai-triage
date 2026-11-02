export const LLM_MODES = ["replay", "record", "live"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** Replay is the default so a fresh clone never spends money. Live must be explicit. */
export function getLlmMode(value = process.env.LLM_MODE): LlmMode {
  if (value === undefined || value === "") return "replay";
  if ((LLM_MODES as readonly string[]).includes(value)) return value as LlmMode;
  throw new Error(`Invalid LLM_MODE "${value}". Expected one of: ${LLM_MODES.join(", ")}`);
}
