import type { Options } from "tsup";

// What the api and worker bundles share. Everything is bundled (workspace packages and npm
// dependencies alike), so the runtime image needs node and these files, not node_modules.
export const serverBundle: Options = {
  format: ["esm"],
  target: "node24",
  platform: "node",
  noExternal: [/.*/],
  // pg's optional native binding is required lazily, only when asked for.
  external: ["pg-native"],
  // Bundled CommonJS code calls require() for Node builtins, which an ESM bundle lacks. Give the
  // bundle a real require.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  splitting: true,
  clean: true,
};
