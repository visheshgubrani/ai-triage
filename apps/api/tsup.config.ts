import { defineConfig } from "tsup";
import { serverBundle } from "../worker/tsup.shared";

export default defineConfig({ ...serverBundle, entry: { index: "src/index.ts" } });
