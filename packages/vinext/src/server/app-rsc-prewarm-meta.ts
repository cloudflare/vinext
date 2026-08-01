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

export function hasRscPrewarmManifestMeta(): boolean {
  return getRscPrewarmManifestMetaHtml().length > 0;
}

export function removeRscPrewarmManifestInvalidatedHeaders(headers: Headers): void {
  if (!hasRscPrewarmManifestMeta()) return;
  headers.delete("Content-Length");
  headers.delete("ETag");
}

export function injectRscPrewarmManifestMetaHtml(html: string): string {
  const metaHtml = getRscPrewarmManifestMetaHtml();
  if (!metaHtml || html.includes(`name="${RSC_PREWARM_MANIFEST_META_NAME}"`)) return html;
  const index = html.toLowerCase().indexOf("</head>");
  if (index === -1) return html;
  return html.slice(0, index) + metaHtml + html.slice(index);
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
  const existingMetaMarker = `name="${RSC_PREWARM_MANIFEST_META_NAME}"`;
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
          controller.enqueue(
            encoder.encode(
              pending.includes(existingMetaMarker)
                ? pending
                : pending.slice(0, index) + metaHtml + pending.slice(index),
            ),
          );
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
