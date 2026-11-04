// The modes live in core (the api reads them without loading any model SDK); re-exported here.
export { callModeOf, getLlmMode, LLM_MODES, type LlmMode } from "@ai-triage/core";

export * from "./cost";
export * from "./errors";
export * from "./gateway";
export * from "./hash";
export * from "./output";
export * from "./providers";
export * from "./recorded";
export * from "./transports";

import type { LlmMode } from "@ai-triage/core";
import { liveTransport, recordTransport, replayTransport, type Transport } from "./transports";

/** The transport for a mode. Only record and live construct API clients (and need keys). */
export function createTransport(mode: LlmMode, cassetteDir: string): Transport {
  const base =
    mode === "replay"
      ? replayTransport(cassetteDir)
      : mode === "record"
        ? recordTransport(liveTransport(), cassetteDir)
        : liveTransport();
  // The simulator costs nothing and isn't a real model, so whatever the mode, `sim:` requests go to
  // it (never to a cassette, never recorded).
  const simulator = liveTransport();
  return { send: (request, meta) => (request.provider === "sim" ? simulator : base).send(request, meta) };
}
