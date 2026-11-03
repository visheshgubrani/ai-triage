import type { Effort } from "./index";

// Model providers and the curated model catalog. A model ref is a bare Claude id (`claude-opus-5-5`)
// or `provider:model` for everything else (`deepseek:deepseek-flash`, `openrouter:openai/gpt-6.1-terra`).
// Adding a model takes one entry here plus a `model_prices` seed row (packages/db/src/seed/prices.ts):
// live calls reserve budget at the model's price, so an unpriced model can't be called.

/** `anthropic` uses the Messages API; the others speak the OpenAI Chat Completions API. */
export const PROVIDERS = ["anthropic", "openai", "deepseek", "openrouter", "compat"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ModelInfo {
  provider: Provider;
  /**
   * `json_schema`: decoding is constrained to the (reduced) schema. `json_object`: the model only
   * promises valid JSON, so the schema goes in the system prompt and Ajv catches the rest.
   */
  structuredOutput: "json_schema" | "json_object";
  /** Inputs sent as such. A text-only model gets a text-layer PDF as per-page text, and can't take scans. */
  inputs: { pdf: boolean; images: boolean };
  /** Effort values the model accepts; `["none"]` when it has no effort control. */
  efforts: readonly Effort[];
}

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
const GPT_EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
const CLAUDE = { provider: "anthropic", structuredOutput: "json_schema", inputs: { pdf: true, images: true } } as const;

/** Every model a config may use. Capabilities checked against provider docs on 2026-11-03. */
export const MODEL_CATALOG = {
  "claude-opus-5-5": { ...CLAUDE, efforts: CLAUDE_EFFORTS },
  "claude-sonnet-5-5": { ...CLAUDE, efforts: CLAUDE_EFFORTS },
  "claude-haiku-5-5": { ...CLAUDE, efforts: CLAUDE_EFFORTS },
  "openai:gpt-6.1-terra": {
    provider: "openai",
    structuredOutput: "json_schema",
    inputs: { pdf: true, images: true },
    efforts: GPT_EFFORTS,
  },
  // JSON mode only (no json_schema); reasoning_effort accepts none/low/high/max.
  "deepseek:deepseek-flash": {
    provider: "deepseek",
    structuredOutput: "json_object",
    inputs: { pdf: false, images: true },
    efforts: ["none", "low", "high", "max"],
  },
  "openrouter:openai/gpt-6.1-terra": {
    provider: "openrouter",
    structuredOutput: "json_schema",
    inputs: { pdf: true, images: true },
    efforts: GPT_EFFORTS,
  },
  // Any OpenAI-compatible server (Ollama, vLLM, LM Studio) at OPENAI_COMPAT_BASE_URL.
  "compat:qwen3": {
    provider: "compat",
    structuredOutput: "json_schema",
    inputs: { pdf: false, images: false },
    efforts: ["none"],
  },
} as const satisfies Record<string, ModelInfo>;

export type ModelRef = keyof typeof MODEL_CATALOG;
export const MODEL_REFS = Object.keys(MODEL_CATALOG) as ModelRef[];

export const isModelRef = (value: unknown): value is ModelRef =>
  typeof value === "string" && Object.hasOwn(MODEL_CATALOG, value);

export function modelInfo(ref: ModelRef): ModelInfo {
  return MODEL_CATALOG[ref];
}

/** Splits a ref into its provider and the provider's own model name. Bare ids are Claude models. */
export function parseModelRef(ref: string): { provider: Provider; model: string } {
  const colon = ref.indexOf(":");
  if (colon === -1) return { provider: "anthropic", model: ref };
  const provider = ref.slice(0, colon);
  if (!(PROVIDERS as readonly string[]).includes(provider) || provider === "anthropic") {
    throw new Error(`unknown model provider in "${ref}"`);
  }
  return { provider: provider as Provider, model: ref.slice(colon + 1) };
}
