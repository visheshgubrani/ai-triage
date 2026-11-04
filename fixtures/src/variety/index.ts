// The mail variety generator (docs/reliability.md): hundreds of kinds of email a shared business
// inbox really gets, from about 40 base shapes varied by language, encoding, layout and
// attachment. Seeded and deterministic: message i of seed s is always the same bytes (apart from
// MIME boundaries). Generated on the fly for load tests and the parse robustness test, never
// committed. `expected` is what a reasonable triage would do with it, for load reports, not a label.
import { CLIENTS, invoiceData, invoiceLines, person, supportData, VENDORS } from "../gen/data";
import { renderDocx, renderPdf } from "../gen/render";
import { addDays, createRng, mailDate, money, type Rng } from "../gen/rng";
import { type Charset, encodedWord, type Leaf, type MimePart, renderMessage, SHIFT_JIS_INVOICE } from "./mime";

export type Expected = "invoice" | "support_request" | "contract" | "other" | "skip";

export interface VarietyMail {
  /** Shape, plus the variations applied: `invoice-pdf/de/qp`. Hundreds of distinct values. */
  kind: string;
  expected: Expected;
  messageId: string;
  eml: Uint8Array;
}

type Lang = "en" | "de" | "fr" | "es";
const LANGS: Lang[] = ["en", "en", "en", "de", "fr", "es"];

const PHRASES: Record<Lang, { invoice: string; pay: string; hello: string; thanks: string; attached: string }> = {
  en: {
    invoice: "Invoice",
    pay: "Please pay by",
    hello: "Hello",
    thanks: "Thanks",
    attached: "Please find the invoice attached.",
  },
  de: {
    invoice: "Rechnung",
    pay: "Bitte zahlen Sie bis",
    hello: "Guten Tag",
    thanks: "Vielen Dank",
    attached: "Anbei erhalten Sie die Rechnung.",
  },
  fr: {
    invoice: "Facture",
    pay: "Merci de régler avant le",
    hello: "Bonjour",
    thanks: "Merci",
    attached: "Veuillez trouver la facture ci-jointe.",
  },
  es: {
    invoice: "Factura",
    pay: "Por favor pague antes del",
    hello: "Hola",
    thanks: "Gracias",
    attached: "Adjuntamos la factura.",
  },
};

interface Ctx {
  rng: Rng;
  index: number;
  lang: Lang;
  charset: Charset;
  to: string;
  date: string;
  id: string;
}

interface Built {
  shape: string;
  expected: Expected;
  subject: string;
  from: string;
  body: MimePart;
  headers?: string[];
  /** Replaces the generated Message-ID header (or drops it, with null). */
  messageId?: string | null;
}

const text = (body: string, ctx: Ctx, encoding: Leaf["encoding"] = "quoted-printable"): Leaf => ({
  contentType: "text/plain",
  body,
  charset: ctx.charset,
  encoding,
});
const html = (body: string, ctx: Ctx): Leaf => ({
  contentType: "text/html",
  body: `<!doctype html><html><body>${body}</body></html>`,
  charset: ctx.charset,
});
const attachment = (name: string, contentType: string, bytes: Uint8Array): Leaf => ({
  contentType: `${contentType}; name="${name}"`,
  body: bytes,
  encoding: "base64",
  disposition: `attachment; filename="${name}"`,
});
const toHtml = (lines: string[]) => lines.map((l) => (l ? `<p>${l.replace(/</g, "&lt;")}</p>` : "<br>")).join("");

async function invoiceMail(ctx: Ctx, layout: "plain" | "html" | "pdf" | "docx" | "forward" | "reply" | "reminder") {
  const d = invoiceData(ctx.rng);
  const p = PHRASES[ctx.lang];
  const lines = invoiceLines(d, ctx.index % 3);
  const from = `${d.vendor.name} <billing@${d.vendor.domain}>`;
  const subject = `${p.invoice} ${d.number}`;
  const note = `${p.hello},\n\n${p.attached}\n${p.pay} ${d.due}.\n\n${p.thanks},\n${d.vendor.name}`;
  switch (layout) {
    case "plain":
      return { shape: "invoice-plain", subject, from, body: text(`${note}\n\n${lines.join("\n")}`, ctx) };
    case "html":
      return {
        shape: "invoice-html",
        subject,
        from,
        body: { multipart: "alternative", parts: [text(lines.join("\n"), ctx), html(toHtml(lines), ctx)] } as MimePart,
      };
    case "pdf":
      return {
        shape: "invoice-pdf",
        subject,
        from,
        body: {
          multipart: "mixed",
          parts: [text(note, ctx), attachment(`${d.number}.pdf`, "application/pdf", await renderPdf(lines))],
        } as MimePart,
      };
    case "docx":
      return {
        shape: "invoice-docx",
        subject,
        from,
        body: {
          multipart: "mixed",
          parts: [
            text(note, ctx),
            attachment(
              `${d.number}.docx`,
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              await renderDocx(lines),
            ),
          ],
        } as MimePart,
      };
    case "forward": {
      // A colleague forwards it, the original inline as message/rfc822.
      const inner = renderMessage(
        [
          `From: ${from}`,
          `To: ap@${d.client.name.toLowerCase().replace(/\W+/g, "")}.example`,
          `Subject: ${subject}`,
          `Date: ${ctx.date}`,
        ],
        text(`${note}\n\n${lines.join("\n")}`, ctx),
      );
      const colleague = person(ctx.rng);
      return {
        shape: "invoice-forwarded",
        subject: `Fwd: ${subject}`,
        from: `${colleague.name} <${colleague.email}>`,
        body: {
          multipart: "mixed",
          parts: [
            text("Can you pay this one? Thanks.", ctx),
            { contentType: "message/rfc822", body: inner, encoding: "8bit", disposition: "inline" },
          ],
        } as MimePart,
      };
    }
    case "reply": {
      const colleague = person(ctx.rng);
      const quoted = lines.map((l) => `> ${l}`).join("\n");
      return {
        shape: "invoice-reply-chain",
        subject: `Re: ${subject}`,
        from: `${colleague.name} <${colleague.email}>`,
        body: text(
          `Approved, please pay.\n\nOn ${ctx.date}, ${from} wrote:\n> ${note.replace(/\n/g, "\n> ")}\n${quoted}`,
          ctx,
        ),
        headers: [
          `In-Reply-To: <${ctx.id}-orig@${d.vendor.domain}>`,
          `References: <${ctx.id}-orig@${d.vendor.domain}>`,
        ],
      };
    }
    case "reminder":
      return {
        shape: "invoice-reminder",
        subject: `Reminder: ${subject} is overdue`,
        from,
        body: text(
          `${p.hello},\n\nOur records show invoice ${d.number} for ${money(d.total)} ${d.currency} is past due (${p.pay} ${d.due}).\n\n${p.thanks}`,
          ctx,
        ),
      };
  }
}

function supportMail(ctx: Ctx, layout: "plain" | "html" | "thread" | "angry") {
  const s = supportData(ctx.rng, ctx.index);
  const from = `${s.customer.name} <${s.customer.email}>`;
  const subjects = ["Problem with my order", "Help needed", "Refund request", "Account issue", "Item arrived damaged"];
  const subject = subjects[ctx.index % subjects.length] ?? "Help";
  switch (layout) {
    case "plain":
      return { shape: "support-plain", subject, from, body: text(s.body, ctx) };
    case "html":
      return { shape: "support-html", subject, from, body: html(`<p>${s.body.replace(/\n/g, "<br>")}</p>`, ctx) };
    case "thread": {
      const history = Array.from(
        { length: 1 + (ctx.index % 4) },
        (_, i) => `> [message ${i + 1} of the thread]\n> ${s.body.split("\n")[0]}`,
      );
      return {
        shape: "support-followup-thread",
        subject: `Re: Re: ${subject}`,
        from,
        body: text(`Any update on this?\n\n${history.join("\n>\n")}`, ctx),
      };
    }
    case "angry":
      return {
        shape: "support-urgent",
        subject: `URGENT!!! ${subject.toUpperCase()} 😡`,
        from,
        body: text(`${s.body}\n\nThis is the THIRD time I write. 😤`, ctx),
      };
  }
}

async function contractMail(ctx: Ctx, layout: "pdf" | "docx" | "amendment") {
  const a = ctx.rng.pick(VENDORS);
  const b = ctx.rng.pick(CLIENTS);
  const effective = addDays("2026-02-01", ctx.rng.int(0, 200));
  const title =
    layout === "amendment" ? "AMENDMENT No. 1 TO THE MASTER SERVICES AGREEMENT" : "MASTER SERVICES AGREEMENT";
  const lines = [
    title,
    "",
    `This agreement is made between ${a.name} ("Supplier") and ${b.name} ("Customer"), effective ${effective}.`,
    "1. Services. Supplier provides the services described in each statement of work.",
    "2. Term. This agreement starts on the effective date and runs for 12 months.",
    "3. Governing law. This agreement is governed by the laws of England and Wales.",
    "",
    `Signed for ${a.name}: ______    Signed for ${b.name}: ______`,
  ];
  const from = `Legal <legal@${a.domain}>`;
  const bytes = layout === "docx" ? await renderDocx(lines) : await renderPdf(lines);
  const name = layout === "docx" ? "agreement.docx" : "agreement.pdf";
  const mime =
    layout === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf";
  return {
    shape: `contract-${layout}`,
    subject: layout === "amendment" ? `Amendment to our MSA, for signature` : `Signed MSA: ${a.name} / ${b.name}`,
    from,
    body: {
      multipart: "mixed",
      parts: [text("Please find the agreement attached.", ctx), attachment(name, mime, bytes)],
    } as MimePart,
  };
}

function businessOther(ctx: Ctx, shape: string): Built {
  const v = ctx.rng.pick(VENDORS);
  const from = `${v.name} <orders@${v.domain}>`;
  const n = ctx.rng.int(10000, 99999);
  const bodies: Record<string, [string, string]> = {
    "purchase-order": [
      `Purchase order PO-${n}`,
      `Please supply the following:\n2 x ${v.items[0]}\nDeliver by ${addDays("2026-03-01", n % 60)}.`,
    ],
    receipt: [`Your receipt #${n}`, `Thank you for your payment of ${money(n / 100)} EUR on ${ctx.date}.`],
    "credit-note": [
      `Credit note CN-${n}`,
      `We have issued a credit of ${money(n / 300)} against invoice ${v.prefix}-${n % 10000}.`,
    ],
    "shipping-notice": [`Your order has shipped`, `Tracking number 1Z${n}${n}. Expected delivery in 3 days.`],
    "order-confirmation": [`Order confirmation ${n}`, `We received your order ${n} and will ship it soon.`],
    "quote-request": [`Request for quotation`, `Could you quote 500 units of ${v.items[0]} delivered to Leeds?`],
    "payment-confirmation": [`Payment received`, `We received your transfer of ${money(n / 50)} GBP. Thank you.`],
    "job-application": [
      `Application: operations analyst`,
      `Please find my CV attached. I would love to join your team.`,
    ],
  };
  const [subject, body] = bodies[shape] ?? ["Hello", "Hello"];
  return { shape, expected: "other", subject, from, body: text(body, ctx) };
}

function noise(ctx: Ctx, shape: string): Built {
  const v = ctx.rng.pick(VENDORS);
  switch (shape) {
    case "newsletter":
      return {
        shape,
        expected: "other",
        subject: `${v.name} monthly news`,
        from: `${v.name} <news@${v.domain}>`,
        body: {
          multipart: "alternative",
          parts: [text("Our news this month.", ctx), html("<h1>News</h1><p>Our news this month.</p>", ctx)],
        },
        headers: [
          `List-Unsubscribe: <mailto:unsubscribe@${v.domain}>`,
          `List-Id: <news.${v.domain}>`,
          "Precedence: bulk",
        ],
      };
    case "auto-reply-ooo":
      return {
        shape,
        expected: "skip",
        subject: "Out of office: back on Monday",
        from: `${person(ctx.rng).name} <ooo@example.com>`,
        body: text("I am out of the office until Monday with limited access to email.", ctx),
        headers: ["Auto-Submitted: auto-replied", "X-Auto-Response-Suppress: All"],
      };
    case "auto-reply-vacation":
      return {
        shape,
        expected: "skip",
        subject: "Automatic reply: Invoice",
        from: `Accounts <accounts@${v.domain}>`,
        body: text("Thank you for your message. We will reply within two working days.", ctx),
        headers: ["X-Autoreply: yes", "Precedence: auto_reply"],
      };
    case "bounce":
      return {
        shape,
        expected: "skip",
        subject: "Undelivered Mail Returned to Sender",
        from: "MAILER-DAEMON@mail.example.com",
        body: {
          multipart: "report; report-type=delivery-status",
          parts: [
            text("This is the mail system. Your message could not be delivered to someone@nowhere.example.", ctx),
            {
              contentType: "message/delivery-status",
              body: "Reporting-MTA: dns; mail.example.com\r\n\r\nFinal-Recipient: rfc822; someone@nowhere.example\r\nAction: failed\r\nStatus: 5.1.1\r\n",
              encoding: "7bit",
            },
          ],
        },
      };
    case "calendar-invite":
      return {
        shape,
        expected: "other",
        subject: "Invitation: quarterly review",
        from: `${person(ctx.rng).name} <calendar@example.com>`,
        body: {
          multipart: "alternative",
          parts: [
            text("You are invited to the quarterly review.", ctx),
            {
              contentType: "text/calendar; method=REQUEST",
              body: "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Quarterly review\r\nDTSTART:20261110T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
              encoding: "7bit",
            },
          ],
        },
      };
    case "read-receipt":
      return {
        shape,
        expected: "skip",
        subject: "Read: Invoice",
        from: `${person(ctx.rng).name} <reader@example.com>`,
        body: {
          multipart: "report; report-type=disposition-notification",
          parts: [
            text("Your message was read.", ctx),
            {
              contentType: "message/disposition-notification",
              body: "Disposition: manual-action/MDN-sent-manually; displayed\r\n",
              encoding: "7bit",
            },
          ],
        },
      };
    case "password-reset":
      return {
        shape,
        expected: "other",
        subject: "Reset your password",
        from: `noreply@${v.domain}`,
        body: text("Click the link to reset your password. If you didn't ask, ignore this.", ctx),
      };
    case "marketing":
      return {
        shape,
        expected: "other",
        subject: "50% off this week only!",
        from: `${v.name} <deals@${v.domain}>`,
        body: html('<table><tr><td><img src="https://tracker.example/pixel.gif"><h2>Sale!</h2></td></tr></table>', ctx),
        headers: [`List-Unsubscribe: <https://${v.domain}/unsubscribe>`],
      };
    default:
      return {
        shape: "personal",
        expected: "other",
        subject: "Lunch on Friday?",
        from: `${person(ctx.rng).name} <friend@example.com>`,
        body: text("Are you free for lunch on Friday?", ctx),
      };
  }
}

async function edgeCase(ctx: Ctx, shape: string): Promise<Built> {
  const d = invoiceData(ctx.rng);
  const from = `${d.vendor.name} <billing@${d.vendor.domain}>`;
  const lines = invoiceLines(d, 0).join("\n");
  switch (shape) {
    case "winmail-dat":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: {
          multipart: "mixed",
          parts: [
            text(lines, ctx),
            attachment("winmail.dat", "application/ms-tnef", Uint8Array.from([0x78, 0x9f, 0x3e, 0x22, 0, 0, 1, 2, 3])),
          ],
        },
      };
    case "zero-byte-attachment":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: {
          multipart: "mixed",
          parts: [text(lines, ctx), attachment("invoice.pdf", "application/pdf", new Uint8Array())],
        },
      };
    case "cid-inline-image":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: {
          multipart: "related",
          parts: [
            html(`<img src="cid:logo@x"><pre>${lines}</pre>`, ctx),
            {
              contentType: "image/png",
              body: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              encoding: "base64",
              disposition: "inline",
              contentId: "logo@x",
            },
          ],
        },
      };
    case "huge-body":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: text(`${lines}\n\n${"Terms and conditions apply. ".repeat(8000)}`, ctx),
      };
    case "malformed-headers":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from: `"Unclosed quote <billing@${d.vendor.domain}>`,
        body: text(lines, ctx),
        headers: [
          "X-Broken-Header-Without-Value:",
          "Received: from nowhere\r\n\tby somewhere; Thu, 32 Foo 2026 25:61:00 +9999",
        ],
      };
    case "missing-message-id":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: text(lines, ctx),
        messageId: null,
      };
    case "duplicate-message-id":
      // The same Message-ID as message 0 of this seed: ingestion must treat it as a duplicate.
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number} (resent)`,
        from,
        body: text(lines, ctx),
        messageId: `<variety-dup@mail.variety.test>`,
      };
    case "utf8-emoji":
      return {
        shape,
        expected: "support_request",
        subject: "Help 🙏 my order is broken 📦💥",
        from: `Zoë Ünal <zoe@example.com>`,
        body: text("Hi 👋\nMy order ORD-123456 arrived broken 💔. Please send a replacement 🙏", {
          ...ctx,
          charset: "utf-8",
        }),
      };
    case "shift-jis":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: {
          contentType: "text/plain",
          body: Uint8Array.from([...SHIFT_JIS_INVOICE, 0x0d, 0x0a, ...Buffer.from(lines, "latin1")]),
          charset: "shift_jis",
          encoding: "base64",
        },
      };
    case "html-only":
      return {
        shape,
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: html(toHtml(invoiceLines(d, 1)), ctx),
      };
    default:
      return {
        shape: "many-recipients",
        expected: "invoice",
        subject: `Invoice ${d.number}`,
        from,
        body: text(lines, ctx),
        headers: [`Cc: ${Array.from({ length: 30 }, (_, i) => `cc${i}@example.com`).join(", ")}`],
      };
  }
}

const SHAPES: { weight: number; build: (ctx: Ctx) => Built | Promise<Built> }[] = [
  ...(["plain", "html", "pdf", "docx", "forward", "reply", "reminder"] as const).map((layout) => ({
    weight: layout === "pdf" ? 4 : 2,
    build: async (ctx: Ctx) => ({ expected: "invoice" as Expected, ...(await invoiceMail(ctx, layout)) }),
  })),
  ...(["plain", "html", "thread", "angry"] as const).map((layout) => ({
    weight: 2,
    build: (ctx: Ctx) => ({ expected: "support_request" as Expected, ...supportMail(ctx, layout) }),
  })),
  ...(["pdf", "docx", "amendment"] as const).map((layout) => ({
    weight: 1,
    build: async (ctx: Ctx) => ({ expected: "contract" as Expected, ...(await contractMail(ctx, layout)) }),
  })),
  ...[
    "purchase-order",
    "receipt",
    "credit-note",
    "shipping-notice",
    "order-confirmation",
    "quote-request",
    "payment-confirmation",
    "job-application",
  ].map((shape) => ({ weight: 1, build: (ctx: Ctx) => businessOther(ctx, shape) })),
  ...[
    "newsletter",
    "auto-reply-ooo",
    "auto-reply-vacation",
    "bounce",
    "calendar-invite",
    "read-receipt",
    "password-reset",
    "marketing",
    "personal",
  ].map((shape) => ({ weight: 1, build: (ctx: Ctx) => noise(ctx, shape) })),
  ...[
    "winmail-dat",
    "zero-byte-attachment",
    "cid-inline-image",
    "huge-body",
    "malformed-headers",
    "missing-message-id",
    "duplicate-message-id",
    "utf8-emoji",
    "shift-jis",
    "html-only",
    "many-recipients",
  ].map((shape) => ({ weight: 0.5, build: (ctx: Ctx) => edgeCase(ctx, shape) })),
];
const TOTAL_WEIGHT = SHAPES.reduce((s, x) => s + x.weight, 0);

/** Message `index` of the stream for `seed`, addressed to `to`. */
export async function varietyMail(seed: number, index: number, to = "inbox@variety.test"): Promise<VarietyMail> {
  // Draws come first, outside any rendering, so a shape's output doesn't shift the next draws.
  const rng = createRng(seed * 1_000_003 + index);
  const roll = rng.next() * TOTAL_WEIGHT;
  let below = 0;
  const shape =
    SHAPES.find((s) => {
      below += s.weight;
      return roll < below;
    }) ?? SHAPES[0];
  const lang = rng.pick(LANGS);
  const charset: Charset =
    lang === "en" ? rng.pick(["utf-8", "utf-8", "iso-8859-1", "windows-1252"] as const) : "utf-8";
  const id = `variety-${seed}-${index}`;
  const date = mailDate(addDays("2026-01-05", rng.int(0, 280)), rng.int(6, 22));
  const ctx: Ctx = { rng, index, lang, charset, to, date, id };
  const built = await shape!.build(ctx);
  const messageId = built.messageId === undefined ? `<${id}@mail.variety.test>` : built.messageId;
  const headers = [
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    `From: ${encodedWord(built.from)}`,
    `To: ${to}`,
    `Subject: ${encodedWord(built.subject)}`,
    `Date: ${date}`,
    ...(built.headers ?? []),
  ];
  return {
    kind: `${built.shape}/${lang}/${charset}`,
    expected: built.expected,
    messageId: messageId ?? "",
    eml: renderMessage(headers, built.body),
  };
}

/** `count` messages of the stream for `seed`. */
export async function varietyMails(seed: number, count: number, to?: string): Promise<VarietyMail[]> {
  const out: VarietyMail[] = [];
  for (let i = 0; i < count; i++) out.push(await varietyMail(seed, i, to));
  return out;
}
