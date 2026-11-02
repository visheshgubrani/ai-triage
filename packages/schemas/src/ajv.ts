import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** Ajv for draft 2020-12 (what `z.toJSONSchema` emits). `strict: false` allows `x-*` annotations. */
export function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  return ajv;
}
