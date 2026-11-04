// `pnpm config:docs`: renders .env.example and docs/configuration.md from the env registry
// (packages/core/src/env.ts). env.test.ts fails when either file drifts from it.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderConfigDoc, renderEnvExample } from "@ai-triage/core";

const root = join(import.meta.dirname, "../../../..");
writeFileSync(join(root, ".env.example"), renderEnvExample());
writeFileSync(join(root, "docs/configuration.md"), renderConfigDoc());
console.log("wrote .env.example and docs/configuration.md");
