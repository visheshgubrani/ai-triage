import { describe, expect, it } from "vitest";
import { llmTimeoutMs, QUEUE_OPTIONS, QUEUES } from "./index";

// A job that outlives its expiry is retried while the first handler may still be paying for its
// call (architecture §5), so every LLM stage's expiry must outlast its longest model call.
const MARGIN_MS = 30_000;
const LARGEST_EXTRACT_MAX_TOKENS = 64_000;

describe("queue timing", () => {
  it("classify and extract expire only after their longest model call", () => {
    expect(QUEUE_OPTIONS[QUEUES.classify].expireInSeconds * 1000).toBeGreaterThan(
      llmTimeoutMs("classify", 4096) + MARGIN_MS,
    );
    expect(QUEUE_OPTIONS[QUEUES.extract].expireInSeconds * 1000).toBeGreaterThan(
      llmTimeoutMs("extract", LARGEST_EXTRACT_MAX_TOKENS) + MARGIN_MS,
    );
  });

  it("an eval item has room to parse, classify and extract", () => {
    const calls = llmTimeoutMs("classify", 4096) + llmTimeoutMs("extract", LARGEST_EXTRACT_MAX_TOKENS);
    expect(QUEUE_OPTIONS[QUEUES.evalItem].expireInSeconds * 1000).toBeGreaterThan(calls + 60_000 + MARGIN_MS);
  });

  it("caps the extract timeout, and grows it with max_tokens up to there", () => {
    expect(llmTimeoutMs("extract", 16_000)).toBe(460_000);
    expect(llmTimeoutMs("extract", 1_000_000)).toBe(600_000);
  });

  it("caps every backoff, and heartbeats only what runs long", () => {
    for (const [name, options] of Object.entries(QUEUE_OPTIONS)) {
      if (options.retryBackoff) expect(options.retryDelayMax, name).toBeGreaterThan(0);
      // pg-boss refuses heartbeats under 10 seconds.
      if (options.heartbeatSeconds !== undefined) expect(options.heartbeatSeconds, name).toBeGreaterThanOrEqual(10);
    }
  });
});
