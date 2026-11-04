# LLM providers, modes and cassettes

> Reference for work on `packages/llm`, model configs and cassettes. The design is in [architecture.md](architecture.md) §5 ("Claude calls", "Other providers").

## Model refs and the catalog

- **Model refs** are a bare Claude id (`claude-opus-5-5`) or `provider:model` for everything else: `openai:gpt-6.1-terra`, `deepseek:deepseek-flash`, `openrouter:openai/gpt-6.1-terra`, `compat:qwen3`. `compat` is any OpenAI-compatible server (Ollama, vLLM, LM Studio) at `OPENAI_COMPAT_BASE_URL`. Refs are stored as they are in `pipeline_configs`, `llm_calls.model` and `model_prices.model`.
- **`MODEL_CATALOG`** (`packages/core/src/models.ts`) is the closed set of usable models, with their capabilities:
  - `structuredOutput`: `json_schema`, or `json_object` for DeepSeek, whose schema goes in the system prompt and is enforced only by Ajv.
  - `inputs`: `pdf`, `images`.
  - `efforts`: the efforts the model accepts (`none` means no reasoning or no effort control).
  - Config validation checks both the ref and the effort against it.
- **Adding a model:** one `MODEL_CATALOG` entry plus a `MODEL_PRICE_SEED` row (`packages/db/src/seed/prices.ts`). Live calls reserve budget at the model's price, so an unpriced model can't be called. Check ids, capabilities and prices against the provider's docs.
- **Text-only models.** A model without `pdf` input gets a text-layer PDF as per-page text (page-cited evidence still verifies). Scans and images it can't read fail the run as `unsupported_file`.

## Adapters

- They live in `packages/llm/src/providers/`:
  - `anthropic.ts`: the Messages API.
  - `openai-compatible.ts`: Chat Completions through the official `openai` SDK with a `baseURL`.
- Each turns an `LlmRequest` into exact wire params and normalizes the raw response: the stop reason in Claude's names, and usage by price class.
- **Keys** live in the deployment `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPAT_*`). Clients are built on first use, so a key matters only for a provider the active config uses. Replay builds no client.
- **Why not the Vercel AI SDK or `zodResponseFormat`:**
  - Output schemas are versioned JSON Schemas stored per tenant, so compile-time Zod types add nothing; Ajv against the full schema is the check.
  - An abstraction SDK would also own the wire format, which breaks exact-params cassettes.
  - It would hide raw usage, fallback hops and refusal details.
  - It could pick forced `tool_choice`, which returns a 400 on Opus/Sonnet 5.5.

## Claude API notes (checked Nov 2026)

- **SDK:** `@anthropic-ai/sdk`.
- **Effort.** Levels on all three models: `low`/`medium`/`high`/`xhigh`/`max`. Opus and Haiku default to `medium` if unset, so always set it.
  - The default model is `claude-opus-5-5` at `effort: "low"`, set in `output_config.effort` and configurable per stage in `pipeline_configs`.
  - The evals page compares `claude-sonnet-5-5` and `claude-haiku-5-5`.
  - Use only these exact IDs, with no date suffixes.
- **Structured output:** `output_config: { format: { type: "json_schema", schema } }`.
  - The raw API can 400 on unsupported keywords (`minimum`/`maximum`/`minLength`/`maxLength`, recursive schemas). `toApiSchema()` strips them, and Ajv enforces the full schema.
  - Citations are incompatible with structured outputs.
- **Things that changed recently:**
  - Thinking can't be disabled on Opus 5.5; effort is the control.
  - `temperature`/`top_p`/`top_k` now return a 400.
  - Assistant prefill isn't allowed.
  - Forced `tool_choice` returns a 400 on Opus/Sonnet 5.5.
- **Refusals:** always check `stop_reason` before reading content.
- **Fallbacks:** `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`. It isn't available on Batches or Haiku.
- **Usage fields for cost:** `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
- **Prices per MTok (input/output):**

  | Model | Input | Output | Cache read |
  |---|---|---|---|
  | Opus 5.5 | $4 | $20 | $0.20 (0.05x) |
  | Sonnet 5.5 | $2 | $10 | $0.10 (0.05x) |
  | Haiku 5.5 | $0.10 ($0.50 above 100K prompt tokens) | $0.50 ($2.50 above 100K) | 0.1x input |

  - Cache writes are 1.25x (5m) or 2x (1h). Batch is 0.5x.
  - The prices are seeded in `packages/db/src/seed/prices.ts` (verified 2026-11-03). Re-verify before changing them.

## Other providers' quirks

- **Token limit parameter.** OpenAI takes `max_completion_tokens`; the others take `max_tokens`.
- **Effort.** It goes as `reasoning_effort` on OpenAI and DeepSeek, and as `reasoning.effort` on OpenRouter. OpenRouter also gets `provider.require_parameters`, so it only routes to upstreams that honor `response_format`.
- **Cached tokens.** `prompt_tokens` includes them, so uncached input is the difference. DeepSeek also reports `prompt_cache_hit_tokens`.
- **Seed prices.**
  - DeepSeek has peak and off-peak rates. The seed uses peak, so its recorded cost is an upper bound.
  - OpenRouter's seed price is the highest listed upstream, with no cache discount.

## LLM modes

- `LLM_MODE` is `replay` (the default), `record` or `live`. `sim:` models ignore it (above).
  - `replay` serves cassettes from `fixtures/cassettes`. A missing cassette is a hard error (`CassetteMissError`), never a fallback to a paid call.
  - `record` calls the live API and writes cassettes.
  - `live` has to be set on purpose.
- `LLM_MODES`, `getLlmMode` and `callModeOf` live in `@ai-triage/core`, so the api reads them without loading SDKs. `@ai-triage/llm` re-exports them.
- A run (processing or eval) stores the mode it expects. A worker whose mode differs fails the run rather than spending, or replaying, unexpectedly.

## The simulator (`sim:` models)

- **What it is:** `pnpm llm-sim` (port 9050, and a service in the Docker demo) is an OpenAI-compatible Chat Completions server. Its code is `packages/llm/src/testing/simulator.ts`. It answers any classify or extract request with schema-valid output built from the document text:
  - **classify:** the offered category whose name and description words the document uses most;
  - **extract:** labelled values, dates, emails and amounts, quoted verbatim so the evidence gate can verify them.

  Answers are deterministic for a request. Latency and fault rates (429 with Retry-After, 500, slow answers, malformed JSON, refusals) are set with `SIM_*` variables, or `POST /sim/config` during a run.
- **How to use it:** point the worker at it with `LLM_SIMULATOR_URL=http://localhost:9050/v1`, and use the catalog's `sim:simulated` model.
- **Any mode:** simulated calls reach the simulator whatever `LLM_MODE` is, never a cassette. They're stored with `llm_calls.mode = 'simulated'`, cost $0, and are badged "Simulated" wherever Replay is badged.
- **What it's for:**
  - load and chaos tests (`pnpm load`, docs/reliability.md);
  - integration tests;
  - trying custom categories or Gmail intake without a key.

  Never for real decisions: its numbers measure the system, not a model.

## Cassettes

- **Format 2** (`CASSETTE_FORMAT`). A cassette is keyed by the hash of `{ provider, params }` (the exact wire params) and stores the raw provider response.
- **The hash must not depend on the tenant.** Request builders take content and config only (no ids, keys or recipient addresses), and a test checks this.
- **Eval runs replay the same cassettes as production.** Eval items store their source exactly as documents do, so their requests are byte-identical. `evals.e2e.db.test.ts` checks every fixture.
- **`recorded.json`** marks which model refs have a complete set (`isRecorded(dir, model)`), together with the effort they were recorded at.
  - The seed and replay tests build configs at the recorded effort.
  - A set is marked only when no document failed without a recorded response (`retries_exhausted`, `llm_bad_request`, `budget_exhausted`).
- **What's recorded:**
  - `openai:gpt-6.1-terra` at low effort: 112 responses, $0.18 on 2026-11-03.
  - `deepseek:deepseek-flash` at high effort: 110 calls, $0.076, for the eval A/B. The scanned invoice PDF fails as `unsupported_file`, which replay reproduces.
- **`DEMO_MODEL`** (`packages/db/src/pipeline-config.ts`) is the one model shared by the demo tenant, the replay e2e test and the recorder, because a cassette is keyed by the exact request.
- **Re-recording (spends money):** changing the model, effort, a prompt, a request builder or a fixture changes requests.
  - Run `LLM_MODE=record pnpm cassettes:record --yes`. It records only what's missing; add `--all` to replace everything, `--model <ref>` / `--effort <level>` to pick, and `--cap <usd>` to bound spend.
  - Stop `pnpm dev` first, because its replay worker shares the queues.
- **Custom categories don't replay.** A config with a custom category classifies with prompt v2 and offers different categories, so every classify request changes and misses in replay (`cassette_missing`), built-in documents included. Settings → Categories warns before saving. Use `LLM_MODE=live` or the simulator. Built-in-only configs stay on prompt v1, so committed cassettes keep matching.
- **Reclassify.** The recorder also re-extracts misclassified fixtures with their labeled category, so a reviewer's natural Reclassify has a cassette. Any other reclassify in replay fails as `cassette_missing`.
- **Fixtures are generated once and committed** (`pnpm fixtures:generate` keeps existing files unless `--force`, which invalidates cassettes). Random draws in the generator happen outside the file-writing callbacks, so regenerating doesn't shift existing files.
