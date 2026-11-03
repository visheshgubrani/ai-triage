import { convert } from "html-to-text";
import { simpleParser } from "mailparser";

// Emails arrive as Postmark inbound JSON or as .eml files. Ingestion normalizes both to a
// NormalizedEmail, stores each attachment as its own object and the rest as a StoredEmail (JSON),
// so the parse stage handles one format. The Postmark payload is also kept as the source of record.

export interface EmailAttachment {
  filename: string;
  mime: string;
  size: number;
  /** Set for inline (cid:) parts, such as logos in an HTML signature. */
  contentId: string | null;
  content: Uint8Array;
}

export interface NormalizedEmail {
  messageId: string | null;
  subject: string | null;
  from: string | null;
  /** The Date header as sent. */
  date: string | null;
  /** Addresses the message was delivered to (for routing to a tenant). Never shown to the model. */
  recipients: string[];
  /** Plain-text body; derived from the HTML body when there is no text part. */
  text: string;
  attachments: EmailAttachment[];
  /**
   * Authentication-Results header values, topmost first, as received. Never shown to the model;
   * the sender gate trusts only those from the tenant's trusted servers (pipeline/untrusted.ts).
   */
  authResults: string[];
}

export interface StoredAttachment {
  index: number;
  filename: string;
  mime: string;
  size: number;
  contentId: string | null;
  storageKey: string;
}

export interface StoredEmail {
  version: 1;
  messageId: string | null;
  subject: string | null;
  from: string | null;
  date: string | null;
  text: string;
  attachments: StoredAttachment[];
  /** Absent in emails stored before it was recorded (treated as none). */
  authResults?: string[];
}

/** The subset of Postmark's inbound webhook payload this app reads. */
export interface PostmarkInbound {
  MessageID?: string;
  Subject?: string;
  From?: string;
  FromName?: string;
  FromFull?: { Email?: string; Name?: string };
  Date?: string;
  To?: string;
  OriginalRecipient?: string;
  ToFull?: { Email?: string }[];
  CcFull?: { Email?: string }[];
  TextBody?: string;
  HtmlBody?: string;
  Headers?: { Name: string; Value: string }[];
  Attachments?: { Name?: string; Content?: string; ContentType?: string; ContentLength?: number; ContentID?: string }[];
}

const clean = (value: string | undefined | null) => (value?.trim() ? value.trim() : null);
const unbracket = (id: string | null) => id?.replace(/^<|>$/g, "") ?? null;

function htmlToText(html: string): string {
  return convert(html, { wordwrap: false, selectors: [{ selector: "img", format: "skip" }] });
}

function formatAddress(email: string | null, name: string | null): string | null {
  if (!email) return name;
  return name ? `${name} <${email}>` : email;
}

/** Joins a folded header onto one line. */
const unfold = (value: string) => value.replace(/\r?\n[ \t]+/g, " ").trim();

export function normalizePostmark(payload: PostmarkInbound): NormalizedEmail {
  const header = (name: string) =>
    payload.Headers?.find((h) => h.Name.toLowerCase() === name.toLowerCase())?.Value ?? null;
  // The envelope recipient decides the tenant when Postmark gives it; To and Cc are headers the
  // sender wrote, so they are used only without one.
  const original = clean(payload.OriginalRecipient);
  const recipients = (
    original
      ? [original]
      : [...(payload.ToFull ?? []).map((t) => t.Email), ...(payload.CcFull ?? []).map((t) => t.Email)]
  )
    .map((r) => clean(r)?.toLowerCase())
    .filter((r): r is string => !!r);
  return {
    messageId: unbracket(clean(header("Message-ID"))) ?? clean(payload.MessageID),
    subject: clean(payload.Subject),
    from: formatAddress(
      clean(payload.FromFull?.Email ?? payload.From),
      clean(payload.FromFull?.Name ?? payload.FromName),
    ),
    date: clean(payload.Date),
    recipients: [...new Set(recipients)],
    text: clean(payload.TextBody) ?? (payload.HtmlBody ? htmlToText(payload.HtmlBody) : ""),
    authResults: (payload.Headers ?? [])
      .filter((h) => h.Name.toLowerCase() === "authentication-results")
      .map((h) => unfold(h.Value)),
    attachments: (payload.Attachments ?? []).map((a, i) => {
      const content = new Uint8Array(Buffer.from(a.Content ?? "", "base64"));
      return {
        filename: clean(a.Name) ?? `attachment-${i + 1}`,
        mime: clean(a.ContentType)?.toLowerCase() ?? "application/octet-stream",
        size: content.byteLength,
        contentId: clean(a.ContentID),
        content,
      };
    }),
  };
}

export async function normalizeEml(bytes: Uint8Array): Promise<NormalizedEmail> {
  const mail = await simpleParser(Buffer.from(bytes), { skipImageLinks: true });
  const addresses = (field: typeof mail.to) =>
    (Array.isArray(field) ? field : field ? [field] : []).flatMap((a) => a.value.map((v) => v.address ?? ""));
  const first = mail.from?.value[0];
  // The raw line, so the date reads as sent (mailparser parses the header into a Date).
  const dateLine = mail.headerLines.find((h) => h.key === "date")?.line.replace(/^date:\s*/i, "");
  return {
    messageId: unbracket(clean(mail.messageId)),
    subject: clean(mail.subject),
    from: formatAddress(clean(first?.address), clean(first?.name)),
    date: clean(dateLine) ?? mail.date?.toUTCString() ?? null,
    recipients: [
      ...new Set([...addresses(mail.to), ...addresses(mail.cc)].map((r) => r.toLowerCase()).filter(Boolean)),
    ],
    text: clean(mail.text) ?? (mail.html ? htmlToText(mail.html) : ""),
    authResults: mail.headerLines
      .filter((h) => h.key === "authentication-results")
      .map((h) => unfold(h.line.replace(/^authentication-results:\s*/i, ""))),
    attachments: mail.attachments.map((a, i) => ({
      filename: clean(a.filename) ?? `attachment-${i + 1}`,
      mime: a.contentType.toLowerCase(),
      size: a.size,
      contentId: a.related ? clean(a.cid ?? a.contentId) : null,
      content: new Uint8Array(a.content),
    })),
  };
}

/** The HTML body of a raw .eml, if it has one (for display; the pipeline reads the text). */
export async function emlHtml(bytes: Uint8Array): Promise<string | null> {
  const mail = await simpleParser(Buffer.from(bytes), { skipImageLinks: true });
  return typeof mail.html === "string" && mail.html.trim() ? mail.html : null;
}

/**
 * The email body as the model and the evidence check see it. Recipients are left out on purpose:
 * they differ per tenant (inbound address), and the request must hash the same in every tenant.
 */
export function renderEmailBody(email: Pick<StoredEmail, "subject" | "from" | "date" | "text">): string {
  const lines = [
    email.subject !== null ? `Subject: ${email.subject}` : null,
    email.from !== null ? `From: ${email.from}` : null,
    email.date !== null ? `Date: ${email.date}` : null,
  ].filter((l): l is string => l !== null);
  return `${lines.join("\n")}\n\n${email.text.trim()}`.trim();
}
