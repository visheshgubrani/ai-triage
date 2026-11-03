export const LLM_MODES = ["replay", "record", "live"] as const;
export type LlmMode = (typeof LLM_MODES)[number];

/** Replay is the default so a fresh clone never spends money. Live must be explicit. */
export function getLlmMode(value = process.env.LLM_MODE): LlmMode {
  if (value === undefined || value === "") return "replay";
  if ((LLM_MODES as readonly string[]).includes(value)) return value as LlmMode;
  throw new Error(`Invalid LLM_MODE "${value}". Expected one of: ${LLM_MODES.join(", ")}`);
}

export * from "./cost";
export * from "./errors";
export * from "./gateway";
export * from "./hash";
export * from "./output";
export * from "./providers";
export * from "./transports";

import { liveTransport, recordTransport, replayTransport, type Transport } from "./transports";

/** The transport for a mode. Only record and live construct API clients (and need keys). */
export function createTransport(mode: LlmMode, cassetteDir: string): Transport {
  if (mode === "replay") return replayTransport(cassetteDir);
  if (mode === "record") return recordTransport(liveTransport(), cassetteDir);
  return liveTransport();
}
