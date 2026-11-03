import { type Effort, type ModelRef, modelInfo } from "@ai-triage/core";
import { readRecorded } from "@ai-triage/llm";

/** The recorder's default effort for a model: low, or the model's only effort. */
export function defaultEffort(model: ModelRef): Effort {
  const { efforts } = modelInfo(model);
  return efforts.includes("low") ? "low" : (efforts[0] ?? "none");
}

/**
 * The model at the effort its cassettes were recorded with (`recorded.json`), so a config built
 * from it sends exactly the recorded requests.
 */
export function recordedStage(cassetteDir: string, model: ModelRef): { model: ModelRef; effort: Effort } {
  const effort = readRecorded(cassetteDir)[model]?.effort as Effort | undefined;
  return { model, effort: effort ?? defaultEffort(model) };
}
