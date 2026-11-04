import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// `cli ocr-model [--dir /models]`: the optional OCR's model files (deploy/compose.ocr-*.yaml runs it
// once before the OCR server starts). PaddleOCR-VL 1.6 (Apache-2.0) in GGUF from PaddlePaddle's own
// Hugging Face repository, at a pinned revision, each file checked against its SHA-256. Files that
// are already there and match are kept, so restarts download nothing.

const REPO = "PaddlePaddle/PaddleOCR-VL-1.6-GGUF";
const REVISION = "511b09642bb324401f15f97cc23bc67e8f0a291d";
export const OCR_MODEL_FILES = [
  {
    name: "PaddleOCR-VL-1.6-GGUF.gguf",
    bytes: 935_769_056,
    sha256: "f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8",
  },
  {
    name: "PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
    bytes: 881_770_560,
    sha256: "204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a",
  },
] as const;

const dirFlag = process.argv.indexOf("--dir");
const dir = dirFlag >= 0 ? (process.argv[dirFlag + 1] ?? "/models") : "/models";

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

mkdirSync(dir, { recursive: true });
for (const file of OCR_MODEL_FILES) {
  const path = join(dir, file.name);
  if (existsSync(path) && (await sha256Of(path)) === file.sha256) {
    console.log(`${file.name}: present`);
    continue;
  }
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.name}`;
  console.log(`${file.name}: downloading ${(file.bytes / 1e6).toFixed(0)} MB from ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${file.name}: download answered ${res.status}`);
  const partial = `${path}.partial`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(partial));
  const digest = await sha256Of(partial);
  if (digest !== file.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${file.name}: SHA-256 ${digest} doesn't match the pinned ${file.sha256}`);
  }
  renameSync(partial, path);
  console.log(`${file.name}: ok`);
}
