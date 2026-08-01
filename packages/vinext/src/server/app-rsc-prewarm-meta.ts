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

function updateRscPrewarmManifestMetaInHead(html: string, metaHtml: string): string {
  const headEnd = html.toLowerCase().indexOf("</head>");
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
  const closeTag = "</head>";
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

        const index = pending.toLowerCase().indexOf(closeTag);
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
