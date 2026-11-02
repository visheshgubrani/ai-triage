import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  platform: "node",
  // Workspace packages ship TypeScript source, so bundle them in.
  noExternal: [/^@ai-triage\//],
  // Bundled CommonJS deps (pg, via @ai-triage/db) call require() for Node builtins, which an ESM
  // bundle lacks. Give the bundle a real require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  clean: true,
});
