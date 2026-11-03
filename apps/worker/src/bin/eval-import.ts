import { readFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EVAL_SPLITS, isOneOf } from "@ai-triage/core";
import { normalizePostmark, type PostmarkInbound } from "@ai-triage/core/pipeline";
import {
  createDb,
  createPool,
  findTenantBySlug,
  getOrCreateDataset,
  insertEvalItem,
  withTenantTx,
} from "@ai-triage/db";
import { DEMO_TENANT } from "@ai-triage/db/seed";
import { importEvalSource } from "@ai-triage/ingest";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";

// `pnpm eval:import <items.jsonl> [--dataset Main] [--tenant demo]`: adds labeled examples to an eval
// dataset (origin `import`). One JSON object per line:
//   {"file": "docs/inv-01.pdf", "expected_category": "invoice", "expected_fields": {...}, "split": "dev", "tags": []}
// `file` is relative to the JSONL file. A .json file is a Postmark inbound payload, like `pnpm ingest`.
// Content already in the dataset is reported and skipped.

const MIMES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".eml": "message/rfc822",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
};

interface Line {
  file: string;
  expected_category: string;
  expected_fields?: Record<string, unknown>;
  split: string;
  tags?: string[];
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { dataset: { type: "string", default: "Main" }, tenant: { type: "string", default: DEMO_TENANT.slug } },
});
const [input] = positionals;
if (!input) {
  console.error("usage: pnpm eval:import <items.jsonl> [--dataset Main] [--tenant demo]");
  process.exit(2);
}
// pnpm runs package scripts from the package directory; resolve paths from where the user ran it.
const path = resolve(process.env.INIT_CWD ?? process.cwd(), input);
const lines = (await readFile(path, "utf8")).split("\n").map((l) => l.trim());

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
const pool = createPool(databaseUrl);
const storage = createStorage(storageConfigFromEnv());
let added = 0;
let duplicates = 0;
try {
  const tenant = await findTenantBySlug(createDb(pool), values.tenant);
  if (!tenant) throw new Error(`tenant "${values.tenant}" not found`);
  const dataset = await withTenantTx(pool, tenant.id, (tx) => getOrCreateDataset(tx, values.dataset));
  for (const [index, raw] of lines.entries()) {
    if (!raw) continue;
    const where = `${basename(path)}:${index + 1}`;
    const line = JSON.parse(raw) as Line;
    if (!line.file || !line.expected_category) throw new Error(`${where}: "file" and "expected_category" are required`);
    if (!isOneOf(EVAL_SPLITS, line.split))
      throw new Error(`${where}: "split" must be one of ${EVAL_SPLITS.join(", ")}`);
    const file = resolve(dirname(path), line.file);
    const bytes = new Uint8Array(await readFile(file));
    const ext = extname(file).toLowerCase();
    const source =
      ext === ".json"
        ? await (async () => {
            const payload = JSON.parse(new TextDecoder().decode(bytes)) as PostmarkInbound;
            return importEvalSource(storage, tenant.id, {
              kind: "email",
              email: normalizePostmark(payload),
              original: { postmark: payload },
            });
          })()
        : await importEvalSource(storage, tenant.id, {
            kind: "file",
            bytes,
            filename: basename(file),
            mime: MIMES[ext] ?? null,
          });
    const { duplicate } = await withTenantTx(pool, tenant.id, (tx) =>
      insertEvalItem(tx, {
        datasetId: dataset.id,
        source,
        expectedCategory: line.expected_category,
        expectedFields: line.expected_fields ?? {},
        split: line.split as (typeof EVAL_SPLITS)[number],
        origin: "import",
        originRef: where,
        tags: line.tags ?? [],
      }),
    );
    if (duplicate) {
      duplicates++;
      console.log(`${where}: already in ${dataset.name}, skipped`);
    } else {
      added++;
    }
  }
  console.log(`imported ${added} items into ${dataset.name} (${duplicates} already present)`);
} finally {
  await pool.end();
}
