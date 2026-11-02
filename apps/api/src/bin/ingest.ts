import { readFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { parseArgs } from "node:util";

// `pnpm ingest <file> [--to <inbound address>]`: pushes a file through the real ingestion path of a
// running API. A .json file is treated as a Postmark inbound payload (POST /webhooks/postmark, with
// the basic-auth credentials from .env); anything else goes to the REST API with TRIAGE_API_KEY.

const MIMES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".eml": "message/rfc822",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
};

const { positionals, values } = parseArgs({ allowPositionals: true, options: { to: { type: "string" } } });
const [input] = positionals;
if (!input) {
  console.error("usage: pnpm ingest <file.pdf|.docx|.eml|.png|.jpg|.txt|postmark.json> [--to <inbound address>]");
  process.exit(2);
}
// pnpm runs package scripts from the package directory; resolve paths from where the user ran it.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), input);
const bytes = await readFile(path);
const api = process.env.TRIAGE_API_URL ?? "http://localhost:8787";

let res: Response;
if (extname(path).toLowerCase() === ".json") {
  const payload = JSON.parse(bytes.toString("utf8"));
  if (values.to) Object.assign(payload, { OriginalRecipient: values.to, ToFull: [{ Email: values.to }] });
  const { POSTMARK_INBOUND_USER: user, POSTMARK_INBOUND_PASSWORD: password } = process.env;
  if (!user || !password) throw new Error("POSTMARK_INBOUND_USER and POSTMARK_INBOUND_PASSWORD must be set");
  res = await fetch(`${api}/webhooks/postmark`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
} else {
  const key = process.env.TRIAGE_API_KEY;
  if (!key) throw new Error("TRIAGE_API_KEY is not set: create one with `pnpm api-key:create --tenant demo`");
  const mime = MIMES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const form = new FormData();
  form.set("file", new File([bytes], basename(path), { type: mime }));
  res = await fetch(`${api}/v1/documents`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form });
}

const body = await res.text();
console.log(`${res.status} ${body}`);
if (!res.ok) process.exit(1);
