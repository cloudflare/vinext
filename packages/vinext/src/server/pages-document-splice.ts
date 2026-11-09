/**
 * Splices framework output into a serialized custom Pages Router Document.
 *
 * `<Head>`, `<Main />` and `<NextScript />` mark their splice points with the
 * per-render token from `vinext/shims/document-placeholders`, so nothing the
 * Document renders can be taken for one. Each edit slices at a located index
 * instead of calling `String#replace`, so inserted HTML is never parsed for
 * `$&`-style replacement patterns. Like Next.js, a Document that leaves out
 * one of those components gets nothing inserted for it.
 */
import {
  getDocumentHeadCloseMarker,
  getDocumentHeadOpenMarker,
  getDocumentMainPlaceholder,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";

function spliceMarker(html: string, marker: string, insertion: string): string {
  const index = html.indexOf(marker);
  if (index === -1) return html;
  return html.slice(0, index) + insertion + html.slice(index + marker.length);
}

/**
 * Drop `<Head>`'s marker attribute and insert `insertion` right after its
 * opening tag. Dev HTML transforms may add attributes after the marker.
 */
export function spliceDocumentHeadOpen(html: string, token: string, insertion: string): string {
  const marker = getDocumentHeadOpenMarker(token);
  const index = html.indexOf(marker);
  if (index === -1) return html;
  const tagEnd = html.indexOf(">", index + marker.length) + 1;
  if (tagEnd === 0) return html;
  return (
    html.slice(0, index) +
    html.slice(index + marker.length, tagEnd) +
    insertion +
    html.slice(tagEnd)
  );
}

/** Insert `insertion` right before `<Head>`'s closing tag. */
export function spliceDocumentHeadClose(html: string, token: string, insertion: string): string {
  return spliceMarker(html, getDocumentHeadCloseMarker(token), insertion);
}

/** Put the generated hydration scripts where `<NextScript />` rendered. */
export function spliceDocumentScripts(html: string, token: string, scripts: string): string {
  return spliceMarker(html, getDocumentScriptsPlaceholder(token), scripts);
}

/**
 * Split the Document where `<Main />` rendered. Like Next.js, a Document
 * without `<Main />` gets the page body after its own markup.
 */
export function splitDocumentAtMain(
  html: string,
  token: string,
): { prefix: string; suffix: string } {
  const placeholder = getDocumentMainPlaceholder(token);
  const index = html.indexOf(placeholder);
  if (index === -1) return { prefix: html, suffix: "" };
  return { prefix: html.slice(0, index), suffix: html.slice(index + placeholder.length) };
}
