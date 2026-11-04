/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** `invoice_number` → "Invoice number". */
export { humanize } from "@ai-triage/core/review";

/** True when a key event comes from a text field, where single-letter shortcuts must not fire. */
export function isTyping(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}
