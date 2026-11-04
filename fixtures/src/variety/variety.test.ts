import { normalizeEml, parseEmail, type StoredEmail } from "@ai-triage/core/pipeline";
import { describe, expect, it } from "vitest";
import { varietyMail, varietyMails } from "./index";

// Parse robustness (docs/reliability.md): hundreds of kinds of real-world mail through the same
// normalization and parsing as ingestion and the parse stage. None may crash, hang or come out empty.

const COUNT = 500;
const PER_MESSAGE_MS = 2_000;

/** What ingestion stores for an email, with its attachments as blobs (writeStoredEmail, without storage). */
function stored(email: Awaited<ReturnType<typeof normalizeEml>>) {
  const blobs = new Map<string, Uint8Array>();
  const attachments = email.attachments.map((a, index) => {
    const storageKey = `t/test/e/${index}`;
    blobs.set(storageKey, a.content);
    return { index, filename: a.filename, mime: a.mime, size: a.size, contentId: a.contentId, storageKey };
  });
  const stored: StoredEmail = {
    version: 1,
    messageId: email.messageId,
    subject: email.subject,
    from: email.from,
    date: email.date,
    text: email.text,
    attachments,
  };
  return { stored, blobs };
}

describe("mail variety", () => {
  it("is deterministic for a seed and index", async () => {
    const [a, b] = [await varietyMail(7, 42), await varietyMail(7, 42)];
    expect(a.kind).toBe(b.kind);
    expect(a.messageId).toBe(b.messageId);
  });

  it(`covers hundreds of kinds, and every one of ${COUNT} parses quickly into text`, { timeout: 300_000 }, async () => {
    const mails = await varietyMails(1, COUNT);
    expect(new Set(mails.map((m) => m.kind)).size).toBeGreaterThan(100);
    const slow: string[] = [];
    for (const mail of mails) {
      const started = performance.now();
      const email = await normalizeEml(mail.eml);
      const { stored: s, blobs } = stored(email);
      const parts = await parseEmail(s, blobs, { maxPdfPages: 100 }).catch((err: Error) => {
        // An unreadable attachment fails the run on purpose (unsupported_file); the body still parsed.
        if ((err as { reason?: string }).reason) return [];
        throw new Error(`${mail.kind}: ${err.message}`);
      });
      const ms = performance.now() - started;
      if (ms > PER_MESSAGE_MS) slow.push(`${mail.kind} ${Math.round(ms)} ms`);
      // Every message yields readable text: its subject at least, or a body.
      expect(
        `${email.subject ?? ""}${email.text}${parts.map((p) => p.text).join("")}`.trim().length,
        mail.kind,
      ).toBeGreaterThan(0);
      // Offsets are what evidence highlighting relies on: each part's text is a stable string.
      for (const part of parts) expect(typeof part.text, mail.kind).toBe("string");
    }
    expect(slow).toEqual([]);
  });
});
