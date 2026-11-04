import type { IntakeFilter, IntakeFilters } from "../index";

// Intake filters (docs/architecture.md §5): noise recognized by its headers, never its content, so a
// sender can't talk a message past them or into them. Read at normalization (normalizeEml,
// normalizePostmark), stored with the email only when present, and applied by the parse stage on a
// document's first run only: Process anyway (a retry) always runs the pipeline.

/** The headers that mark a message as automatic or bulk. */
export interface MailSignals {
  /** Auto-Submitted (RFC 3834), other than `no`. */
  autoSubmitted?: string;
  /** X-Autoreply / X-Autorespond present. */
  autoReplyHeader?: boolean;
  /** Precedence, lowercased: bulk, list, junk or auto_reply. */
  precedence?: string;
  /** List-Id or List-Unsubscribe present. */
  list?: boolean;
  /** The report type of a multipart/report: delivery-status (a bounce) or disposition-notification (a read receipt). */
  report?: string;
}

const param = (contentType: string, name: string) =>
  new RegExp(`${name}\\s*=\\s*"?([^";\\s]+)`, "i").exec(contentType)?.[1]?.toLowerCase();

/** Signals from a message's header lines (name and value). Undefined when there are none. */
export function mailSignals(headers: readonly { name: string; value: string }[]): MailSignals | undefined {
  const get = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value.trim();
  const signals: MailSignals = {};
  const auto = get("auto-submitted")?.toLowerCase();
  if (auto && auto !== "no") signals.autoSubmitted = auto;
  if (get("x-autoreply") !== undefined || get("x-autorespond") !== undefined) signals.autoReplyHeader = true;
  const precedence = get("precedence")?.toLowerCase();
  if (precedence && ["bulk", "list", "junk", "auto_reply"].includes(precedence)) signals.precedence = precedence;
  if (get("list-id") !== undefined || get("list-unsubscribe") !== undefined) signals.list = true;
  const contentType = get("content-type") ?? "";
  if (/^multipart\/report/i.test(contentType)) {
    const report = param(contentType, "report-type");
    if (report) signals.report = report;
  }
  return Object.keys(signals).length > 0 ? signals : undefined;
}

/** Which filter a message trips, if one that is on. Auto-replies first, then bounces, then bulk. */
export function intakeSkip(signals: MailSignals | undefined, filters: IntakeFilters): IntakeFilter | null {
  if (!signals) return null;
  const tripped: IntakeFilter[] = [];
  if (signals.autoSubmitted || signals.autoReplyHeader || signals.precedence === "auto_reply")
    tripped.push("auto_replies");
  if (signals.report === "delivery-status" || signals.report === "disposition-notification") tripped.push("bounces");
  if (signals.list || (signals.precedence && ["bulk", "list", "junk"].includes(signals.precedence)))
    tripped.push("bulk");
  return tripped.find((f) => filters[f]) ?? null;
}
