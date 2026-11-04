import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isOneOf } from "@ai-triage/core";
import {
  ConfigureError,
  configure,
  mergeRestored,
  OCR_BACKENDS,
  type OcrBackend,
  PROVIDER_KEYS,
  parseEnvFile,
  renderEnvFile,
} from "../install/configure";

// `cli configure --dir /work [--host <name> --email <addr> | --port <n>] [--version x.y.z] [--ocr <backend>|off]`:
// writes the installation's .env (mode 0600), generating every secret, keeping existing values.
// install.sh runs it in a container with the install directory mounted, so the host needs no Node.
// Provider keys come from the environment (docker run -e ANTHROPIC_API_KEY), never from arguments.

const { values: flags } = parseArgs({
  options: {
    dir: { type: "string", default: "." },
    host: { type: "string" },
    email: { type: "string" },
    version: { type: "string" },
    ocr: { type: "string" },
    port: { type: "string" },
    // Behind an existing reverse proxy: the files' public hostname (with --host for the app's).
    "files-host": { type: "string" },
    // ./triage restore: take the secrets the restored data needs from the backup's .env.
    "restore-from": { type: "string" },
  },
});
const ocr = flags.ocr;
if (ocr !== undefined && ocr !== "off" && !isOneOf(OCR_BACKENDS, ocr)) {
  console.error(`--ocr must be one of ${OCR_BACKENDS.join(", ")} or off`);
  process.exit(2);
}

const file = join(flags.dir, ".env");
/** The file's text, or null if there isn't one: read once, not checked first (no race between the two). */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
const current = readIfPresent(file);
const existing = current === null ? {} : parseEnvFile(current);
try {
  const values = configure(
    existing,
    {
      host: flags.host,
      email: flags.email,
      version: flags.version,
      ocr: ocr as OcrBackend | "off" | undefined,
      port: flags.port ? Number(flags.port) : undefined,
      upstream: flags["files-host"] ? { filesHost: flags["files-host"] } : undefined,
    },
    process.env,
  );
  const restoreFrom = flags["restore-from"];
  const final = restoreFrom ? mergeRestored(values, parseEnvFile(readFileSync(restoreFrom, "utf8"))) : values;
  // Written beside it, then renamed over it: never a half-written .env, and the file a reader
  // sees is always a whole one (rename is atomic on one filesystem).
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, renderEnvFile(final), { mode: 0o600, flag: "wx" });
  renameSync(temp, file);
  const keys = PROVIDER_KEYS.filter((k) => values[k]);
  console.log(`${Object.keys(existing).length > 0 ? "Updated" : "Wrote"} ${file}`);
  console.log(`  mode:     ${values.INSTALL_MODE}`);
  console.log(`  address:  ${values.PUBLIC_URL}`);
  console.log(`  files:    ${values.S3_PUBLIC_ENDPOINT}`);
  console.log(
    `  model:    ${values.DEFAULT_MODEL}${keys.length > 0 ? ` (${keys.join(", ")} set)` : " (no provider key yet)"}`,
  );
  console.log(`  ocr:      ${values.OCR_BACKEND}`);
} catch (err) {
  if (!(err instanceof ConfigureError)) throw err;
  console.error(`configure: ${err.message}`);
  process.exit(2);
}
