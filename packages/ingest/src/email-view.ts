import { emlHtml, type PostmarkInbound, type StoredEmail } from "@ai-triage/core/pipeline";
import type { Storage } from "@ai-triage/storage";
import sanitizeHtml from "sanitize-html";

// The review page's view of an email document. The pipeline reads the normalized `email.json`
// (text only); the HTML comes from the original stored next to it (`postmark.json` or `source.eml`,
// see storageKeys.email), and is sanitized here before it reaches the browser. The page also renders
// it in a sandboxed iframe with a CSP that blocks every remote load, so this is one of two layers.

export interface EmailViewData {
  subject: string | null;
  from: string | null;
  date: string | null;
  text: string;
  html: string | null;
  attachments: { index: number; filename: string; mime: string; size: number }[];
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "font", "center"],
  allowedAttributes: {
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan", "align", "valign"],
    th: ["colspan", "rowspan", "align", "valign"],
    table: ["width", "align"],
  },
  // Links may point anywhere (they open in a new tab); images only inline data, so nothing loads remotely.
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["data"] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
  },
  // An image whose remote src was stripped shows nothing useful; drop it.
  exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
};

/** Strips scripts, styles, forms, frames and remote images from an email's HTML. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE);
}

async function getOptional(storage: Storage, key: string): Promise<Uint8Array | null> {
  return (await storage.head(key)) ? storage.get(key) : null;
}

/** The original's HTML body: the Postmark payload's HtmlBody, else the .eml's HTML part. */
async function originalHtml(storage: Storage, sourceKey: string): Promise<string | null> {
  if (!sourceKey.endsWith("/email.json")) return null;
  const base = sourceKey.slice(0, -"/email.json".length);
  const postmark = await getOptional(storage, `${base}/postmark.json`);
  if (postmark) {
    const payload = JSON.parse(new TextDecoder().decode(postmark)) as PostmarkInbound;
    return payload.HtmlBody?.trim() ? payload.HtmlBody : null;
  }
  const eml = await getOptional(storage, `${base}/source.eml`);
  return eml ? emlHtml(eml) : null;
}

/** An email document as the review page shows it. `sourceKey` is the document's (server-issued) key. */
export async function readEmailView(storage: Storage, sourceKey: string): Promise<EmailViewData> {
  const stored = JSON.parse(new TextDecoder().decode(await storage.get(sourceKey))) as StoredEmail;
  const html = await originalHtml(storage, sourceKey);
  return {
    subject: stored.subject,
    from: stored.from,
    date: stored.date,
    text: stored.text,
    html: html ? sanitizeEmailHtml(html) : null,
    attachments: stored.attachments.map(({ index, filename, mime, size }) => ({ index, filename, mime, size })),
  };
}
