import {
  classifyOutputSchema,
  extractOutputSchema,
  fieldGuide,
  type JsonSchema,
  renderPrompt,
  schemaDescription,
  toApiSchema,
} from "@ai-triage/schemas";
import { DOCUMENT_MIMES, OTHER_CATEGORY } from "../index";
import { PipelineError } from "./errors";
import type { LlmContent, LlmRequest, ParsedPart, StageModel } from "./types";

// Requests are built from content and config only: no tenant, document or run ids, storage keys or
// recipient addresses. The same document therefore produces the same request (and cassette hash) in
// any tenant, and the system prompt stays a stable, cacheable prefix.

/** Below the API's 32 MB request limit, with room for the JSON envelope. */
export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;

export interface CategoryOption {
  name: string;
  description: string;
}

type DocumentPart = Pick<ParsedPart, "partIndex" | "kind" | "mime" | "label" | "text" | "storageKey">;

const attr = (value: string) => value.replace(/["<>\n]/g, " ");

function partTag(part: DocumentPart): string {
  const name = part.label ? ` name="${attr(part.label)}"` : "";
  return `<part index="${part.partIndex}" kind="${part.kind}"${name}>`;
}

/**
 * The document as content blocks, in part order: text parts as tagged text, each PDF once as a
 * document block (all its pages), images as image blocks. DOCX and plain text go as text.
 */
export function documentContent(parts: readonly DocumentPart[], blobs: ReadonlyMap<string, Uint8Array>): LlmContent[] {
  const content: LlmContent[] = [];
  const sent = new Set<string>();
  let bytes = 0;
  for (const part of parts) {
    const binary =
      part.mime === DOCUMENT_MIMES.pdf || part.mime === DOCUMENT_MIMES.png || part.mime === DOCUMENT_MIMES.jpeg;
    if (binary && part.storageKey) {
      if (sent.has(part.storageKey)) continue;
      sent.add(part.storageKey);
      const blob = blobs.get(part.storageKey);
      if (!blob) throw new Error(`blob for part ${part.partIndex} was not loaded`);
      const data = Buffer.from(blob).toString("base64");
      bytes += data.length;
      if (part.mime === DOCUMENT_MIMES.pdf) {
        const pages = parts.filter((p) => p.storageKey === part.storageKey).length;
        content.push({ type: "document", mime: DOCUMENT_MIMES.pdf, data, title: part.label, pages });
      } else {
        content.push({ type: "text", text: `${partTag(part)}(image follows)</part>` });
        content.push({ type: "image", mime: part.mime as "image/png" | "image/jpeg", data });
      }
    } else {
      const text = `${partTag(part)}\n${part.text}\n</part>`;
      bytes += Buffer.byteLength(text);
      content.push({ type: "text", text });
    }
  }
  if (bytes > MAX_REQUEST_BYTES) {
    throw new PipelineError("request_too_large", `document is ${(bytes / 2 ** 20).toFixed(1)} MB once encoded`);
  }
  return content;
}

/** Category names offered to the classifier, sorted, with `other` last. */
export function classifyCategories(categories: readonly CategoryOption[]): string[] {
  return [...categories.map((c) => c.name).sort(), OTHER_CATEGORY];
}

export function buildClassifyRequest(input: {
  model: StageModel;
  promptBody: string;
  categories: readonly CategoryOption[];
  parts: readonly DocumentPart[];
  blobs: ReadonlyMap<string, Uint8Array>;
}): LlmRequest {
  const sorted = [...input.categories].sort((a, b) => a.name.localeCompare(b.name));
  return {
    stage: "classify",
    ...input.model,
    system: renderPrompt(input.promptBody, {
      categories: sorted.map((c) => `- ${c.name}: ${c.description}`).join("\n"),
    }),
    content: [...documentContent(input.parts, input.blobs), { type: "text", text: "Classify the document above." }],
    outputSchema: toApiSchema(classifyOutputSchema(classifyCategories(sorted))),
  };
}

export function buildExtractRequest(input: {
  model: StageModel;
  promptBody: string;
  category: string;
  schema: JsonSchema;
  parts: readonly DocumentPart[];
  blobs: ReadonlyMap<string, Uint8Array>;
}): LlmRequest {
  return {
    stage: "extract",
    ...input.model,
    system: renderPrompt(input.promptBody, {
      category: input.category,
      category_description: schemaDescription(input.schema),
      field_guide: fieldGuide(input.schema),
    }),
    content: [
      ...documentContent(input.parts, input.blobs),
      { type: "text", text: "Extract the fields from the document above." },
    ],
    outputSchema: toApiSchema(extractOutputSchema(input.schema)),
  };
}
