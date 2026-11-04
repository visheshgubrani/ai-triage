import { defineConfig } from "tsup";
import { serverBundle } from "./tsup.shared";

// The worker, and every command the Docker image runs (`entrypoint cli <name>`): the bundles share
// chunks, so the CLIs add little.
export default defineConfig({
  ...serverBundle,
  entry: {
    index: "src/index.ts",
    // Loaded by the parse sandbox (src/parse/sandbox.ts) from beside the bundle that runs it.
    "parse-thread": "src/parse/thread.ts",
    "bin/migrate": "../../packages/db/src/bin/migrate.ts",
    "bin/seed": "../../packages/db/src/bin/seed.ts",
    "bin/tenant-create": "../../packages/db/src/bin/tenant-create.ts",
    "bin/api-key-create": "../../packages/db/src/bin/api-key.ts",
    "bin/secrets-rotate-key": "../../packages/db/src/bin/rotate-key.ts",
    "bin/seed-documents": "src/bin/seed-documents.ts",
    "bin/seed-evals": "src/bin/seed-evals.ts",
    "bin/eval-import": "src/bin/eval-import.ts",
    "bin/tenant-delete": "src/bin/tenant-delete.ts",
    "bin/preflight": "src/bin/preflight.ts",
    "bin/fake-google": "../../packages/mailbox/src/testing/serve.ts",
  },
});
