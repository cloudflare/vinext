import { RSC_PREWARM_MANIFEST_META_NAME } from "../client/rsc-prewarm-eligibility.js";
import { escapeHtmlAttr } from "./html.js";

declare global {
  var __VINEXT_RSC_PREWARM_MANIFEST_URL: unknown;
}

export function getRscPrewarmManifestMetaHtml(): string {
  const manifestUrl = globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL;
  if (typeof manifestUrl !== "string" || manifestUrl.length === 0) return "";
  return `<meta name="${RSC_PREWARM_MANIFEST_META_NAME}" content="${escapeHtmlAttr(manifestUrl)}">`;
}

function hasRscPrewarmManifestMeta(): boolean {
  return getRscPrewarmManifestMetaHtml().length > 0;
}

export function removeRscPrewarmManifestInvalidatedHeaders(headers: Headers): void {
  if (!hasRscPrewarmManifestMeta()) return;
  headers.delete("Content-Length");
  headers.delete("ETag");
}

const RSC_PREWARM_MANIFEST_META_SOURCE = `<meta\\b(?=[^>]*\\bname\\s*=\\s*(["'])${RSC_PREWARM_MANIFEST_META_NAME}\\1)[^>]*>`;
const HEAD_RAW_TEXT_ELEMENTS = new Set(["script", "style", "title", "noscript"]);

/** Find the real head close while ignoring markup-looking raw-text contents. */
function findClosingHeadIndex(html: string): number {
  const lower = html.toLowerCase();
  let index = 0;
  let rawTextElement: string | null = null;

  while (index < lower.length) {
    if (rawTextElement !== null) {
      const closeStart = lower.indexOf(`</${rawTextElement}`, index);
      if (closeStart === -1) return -1;
      const closeEnd = lower.indexOf(">", closeStart + rawTextElement.length + 2);
      if (closeEnd === -1) return -1;
      rawTextElement = null;
      index = closeEnd + 1;
      continue;
    }

    const tagStart = lower.indexOf("<", index);
    if (tagStart === -1) return -1;
    if (lower.startsWith("<!--", tagStart)) {
      const commentEnd = lower.indexOf("-->", tagStart + 4);
      if (commentEnd === -1) return -1;
      index = commentEnd + 3;
      continue;
    }

    let tagEnd = tagStart + 1;
    let quote: '"' | "'" | null = null;
    for (; tagEnd < lower.length; tagEnd++) {
      const character = lower[tagEnd];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    if (tagEnd >= lower.length) return -1;

    const tag = lower.slice(tagStart + 1, tagEnd).trim();
    const closing = tag.startsWith("/");
    const name = tag.slice(closing ? 1 : 0).split(/[\s/>]/, 1)[0];
    if (closing && name === "head") return tagStart;
    if (!closing && HEAD_RAW_TEXT_ELEMENTS.has(name) && !tag.endsWith("/")) {
      rawTextElement = name;
    }
    index = tagEnd + 1;
  }

  return -1;
}

function updateRscPrewarmManifestMetaInHead(html: string, metaHtml: string): string {
  const headEnd = findClosingHeadIndex(html);
  if (headEnd === -1) return html;

  const head = html.slice(0, headEnd);
  const tail = html.slice(headEnd);
  const existingMeta = new RegExp(RSC_PREWARM_MANIFEST_META_SOURCE, "i");
  if (existingMeta.test(head)) {
    return head.replace(new RegExp(RSC_PREWARM_MANIFEST_META_SOURCE, "gi"), metaHtml) + tail;
  }
  return metaHtml ? head + metaHtml + tail : html;
}

export function injectRscPrewarmManifestMetaHtml(html: string): string {
  const metaHtml = getRscPrewarmManifestMetaHtml();
  return updateRscPrewarmManifestMetaInHead(html, metaHtml);
}

/** Inject the small, content-hashed eligibility-manifest URL into App HTML. */
export function injectRscPrewarmManifestMeta(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const metaHtml = getRscPrewarmManifestMetaHtml();
  if (!metaHtml) return body;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const maxHeadScanChars = 64 * 1024;
  let pending = "";
  let injected = false;

  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = decoder.decode(chunk, { stream: true });
        if (injected) {
          controller.enqueue(encoder.encode(text));
          return;
        }

        pending += text;

        const index = findClosingHeadIndex(pending);
        if (index !== -1) {
          controller.enqueue(encoder.encode(updateRscPrewarmManifestMetaInHead(pending, metaHtml)));
          pending = "";
          injected = true;
          return;
        }

        // Malformed/fragment HTML must not make the transform buffer an
        // unbounded response. If no closing head appears promptly, fail closed
        // and pass the original stream through without metadata.
        if (pending.length > maxHeadScanChars) {
          controller.enqueue(encoder.encode(pending));
          pending = "";
          injected = true;
        }
      },
      flush(controller) {
        const finalText = pending + decoder.decode();
        controller.enqueue(encoder.encode(finalText));
      },
    }),
  );
}
