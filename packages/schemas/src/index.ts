import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

/** Ajv instance for validating extractions against the full stored JSON Schema. */
export function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  return ajv;
}
