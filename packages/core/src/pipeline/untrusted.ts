// Deterministic checks on content the sender controls (docs/security.md, M5). Both can only send a
// document to review, never approve one: a false positive costs a human glance, a false negative
// leaves the model's judgment, the audit sample and the per-category opt-in as the defences.

// ── Prompt injection ──────────────────────────────────────────────────────────────────────────

/**
 * Phrases addressed to the triage system rather than to a human reader. Kept short and specific:
 * the goal is to catch documents that try to steer the model, not to judge ordinary mail.
 *
 * They run on attacker-controlled text, so they must stay linear: findInjection() first collapses
 * whitespace to single spaces, and the patterns use literal spaces next to tokens that can't contain
 * one, so no part of the input can be matched more than one way (no catastrophic backtracking).
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  // "ignore your validation rules", "disregard all previous instructions"
  /\b(?:ignore|disregard|forget|override)(?: [\w-]+){0,3}? (?:instructions|rules|prompts?|guidelines)\b/i,
  /\byou are now\b/i,
  /\bsystem prompt\b/i,
  // "classify this message as an invoice", "classify it with confidence 1.0"
  /\b(?:classify|categori[sz]e|label|route) (?:it|this|the)(?: [\w-]+){0,2}? (?:as|with)\b/i,
  // A confidence or field name of the model's own output.
  /\b(?:self_)?confidence(?: ?(?:of|=|:|to|at))? ?(?:1(?:\.0+)?|100 ?%)(?![\d.])/i,
  /\b(?:self_confidence|uncertain_fields)\b/i,
  /\b(?:approve|pay) (?:it|this) (?:without|immediately)\b/i,
  /\b(?:note|message|instructions?) (?:to|for) (?:the )?(?:automated|ai|llm|language model)\b/i,
  // The prompt's own part delimiters (escaped before sending, but their presence is telling).
  /<\/?part\b/i,
];

/** The first phrase in `texts` that looks like an instruction to the triage system, or null. */
export function findInjection(texts: readonly string[]): string | null {
  for (const raw of texts) {
    // One linear pass, so the patterns only ever see single spaces.
    const text = raw.replace(/\s+/g, " ");
    for (const pattern of INJECTION_PATTERNS) {
      const match = pattern.exec(text);
      if (match) return match[0].slice(0, 120);
    }
  }
  return null;
}

// ── Sender authentication ─────────────────────────────────────────────────────────────────────

/**
 * Whether email must be authenticated to auto-approve, stored in `pipeline_configs.policy.sender`
 * (versioned with the config, so evals measure it). Authentication-Results headers can be written
 * by anyone, so only those added by a receiving server the tenant trusts count: its authserv-id
 * (e.g. `mx.google.com` when mail is forwarded from Google Workspace). Off by default.
 */
export interface SenderPolicy {
  require: boolean;
  trustedAuthServIds: readonly string[];
}

export const DEFAULT_SENDER_POLICY: SenderPolicy = { require: false, trustedAuthServIds: [] };

export function senderPolicy(policy: unknown): SenderPolicy {
  const sender = ((policy ?? {}) as { sender?: Partial<SenderPolicy> }).sender ?? {};
  return {
    require: sender.require === true,
    trustedAuthServIds: Array.isArray(sender.trustedAuthServIds)
      ? sender.trustedAuthServIds.filter((s): s is string => typeof s === "string").map((s) => s.toLowerCase())
      : [],
  };
}

export interface AuthResults {
  authServId: string;
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

/** RFC 8601 results from the topmost header whose authserv-id is trusted, or null if none is. */
export function trustedAuthResults(headers: readonly string[], trusted: readonly string[]): AuthResults | null {
  for (const header of headers) {
    const authServId = header.split(";")[0]?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (!trusted.includes(authServId)) continue;
    const results = (method: string) =>
      [...header.matchAll(new RegExp(`\\b${method}\\s*=\\s*([a-z]+)`, "gi"))].map((m) => (m[1] ?? "").toLowerCase());
    const dkim = results("dkim");
    return {
      authServId,
      spf: results("spf")[0] ?? null,
      // Several signatures may be checked; one passing is enough for DMARC's purposes.
      dkim: dkim.includes("pass") ? "pass" : (dkim[0] ?? null),
      dmarc: results("dmarc")[0] ?? null,
    };
  }
  return null;
}

/**
 * Authenticated: DMARC passed, or (when the trusted server doesn't evaluate DMARC) DKIM passed. SPF
 * alone isn't enough: forwarding breaks it, and it says nothing about the From address.
 */
export function senderAuthenticated(headers: readonly string[], policy: SenderPolicy): boolean {
  const results = trustedAuthResults(headers, policy.trustedAuthServIds);
  if (!results) return false;
  return results.dmarc === "pass" || (results.dmarc === null && results.dkim === "pass");
}
