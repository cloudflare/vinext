/**
 * Splices framework output into a serialized custom Pages Router Document.
 *
 * `<Head>`, `<Main />` and `<NextScript />` mark their splice points with the
 * per-render token from `vinext/shims/document-placeholders`, so nothing the
 * Document renders can be taken for one. Every edit slices at a located index
 * rather than calling `String#replace`, so inserted HTML is never parsed for
 * `$&`-style replacement patterns.
 */
import {
  getDocumentHeadCloseMarker,
  getDocumentHeadOpenMarker,
  getDocumentMainPlaceholder,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";

// Fallbacks for a Document that renders a plain <head> instead of <Head>.
// They search `maskRawTextContent` output, so only real tags match.
const HEAD_OPEN_TAG_PATTERN = /<head(?:\s[^>]*)?>/i;
const NEXT_DATA_SCRIPT_TAG_PATTERN = /<script\b[^>]*\sid=["']__NEXT_DATA__["']/i;
// Elements the HTML parser reads as text up to their closing tag. React
// writes `dangerouslySetInnerHTML` into them unescaped, so their content can
// hold any tag-like string, request data included.
const RAW_TEXT_ELEMENT_PATTERN =
  /(<(script|style|title|textarea|noscript)\b[^>]*>)([\s\S]*?)(?=<\/\2[\s/>])/gi;

/**
 * Blank the content of raw-text elements, keeping their tags and the string's
 * length, so a tag search on the result finds only real markup at indexes
 * that still map onto `html`. React escapes `<`, `>` and quotes everywhere
 * else, including attribute values.
 */
export function maskRawTextContent(html: string): string {
  return html.replace(
    RAW_TEXT_ELEMENT_PATTERN,
    (_element, openTag: string, _name: string, text: string) => openTag + " ".repeat(text.length),
  );
}

function spliceAt(html: string, start: number, end: number, insertion: string): string {
  return html.slice(0, start) + insertion + html.slice(end);
}

/**
 * Insert `insertion` right after `<Head>`'s opening tag and drop its marker.
 * The marker is the tag's last attribute, so the tag ends where it does.
 */
export function spliceDocumentHeadOpen(html: string, token: string, insertion: string): string {
  const marker = getDocumentHeadOpenMarker(token);
  const index = html.indexOf(marker);
  if (index !== -1) {
    return spliceAt(html, index, index + marker.length, `>${insertion}`);
  }
  if (!insertion) return html;
  const match = HEAD_OPEN_TAG_PATTERN.exec(maskRawTextContent(html));
  if (!match) return html;
  const end = match.index + match[0].length;
  return spliceAt(html, end, end, insertion);
}

/** Replace `<Head>`'s closing marker with `insertion`. */
export function spliceDocumentHeadClose(html: string, token: string, insertion: string): string {
  const marker = getDocumentHeadCloseMarker(token);
  const index = html.indexOf(marker);
  if (index !== -1) {
    return spliceAt(html, index, index + marker.length, insertion);
  }
  if (!insertion) return html;
  const headEnd = maskRawTextContent(html).indexOf("</head>");
  if (headEnd === -1) return html;
  return spliceAt(html, headEnd, headEnd, insertion);
}

/**
 * Put the generated hydration scripts where `<NextScript />` rendered. A
 * Document without NextScript gets them before `</body>` unless it already
 * renders its own `__NEXT_DATA__` script.
 */
export function spliceDocumentScripts(html: string, token: string, scripts: string): string {
  const placeholder = getDocumentScriptsPlaceholder(token);
  const index = html.indexOf(placeholder);
  if (index !== -1) {
    return spliceAt(html, index, index + placeholder.length, scripts);
  }
  const searchable = maskRawTextContent(html);
  if (NEXT_DATA_SCRIPT_TAG_PATTERN.test(searchable)) return html;
  const bodyEnd = searchable.lastIndexOf("</body>");
  if (bodyEnd === -1) return html;
  return spliceAt(html, bodyEnd, bodyEnd, `  ${scripts}\n`);
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
