/**
 * HTML-safe JSON serialization for embedding data in <script> tags.
 *
 * JSON.stringify does NOT escape characters that are meaningful to the
 * HTML parser. If a JSON string value contains "</script>", the browser
 * closes the script tag early — anything after it executes as HTML.
 * This is a well-known stored XSS vector in SSR frameworks.
 *
 * Next.js mitigates this with htmlEscapeJsonString(). We do the same.
 *
 * Characters escaped:
 *   <   → \u003c   (prevents </script> and <!-- breakout)
 *   >   → \u003e   (prevents --> and other HTML close sequences)
 *   &   → \u0026   (prevents &lt; entity interpretation in XHTML)
 *   \u2028 → \\u2028 (line separator — invalid in JS string literals pre-ES2019)
 *   \u2029 → \\u2029 (paragraph separator — same)
 *
 * The result is valid JSON that is also safe to embed in any HTML context
 * without additional escaping.
 */
const HTML_UNSAFE_JSON_CHAR_RE = /[<>&\u2028\u2029]/;
const HTML_UNSAFE_JSON_CHARS_RE = /[<>&\u2028\u2029]/g;
const HTML_UNSAFE_JSON_ESCAPES: Readonly<Record<string, string>> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

function escapeHtmlUnsafeJsonChar(char: string): string {
  return HTML_UNSAFE_JSON_ESCAPES[char];
}

export function safeJsonStringify(data: unknown): string {
  // One scan instead of five chained replace() passes. Most payloads contain
  // none of these characters, so the common case returns without copying.
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError("Cannot serialize value as JSON");
  if (!HTML_UNSAFE_JSON_CHAR_RE.test(json)) return json;
  return json.replace(HTML_UNSAFE_JSON_CHARS_RE, escapeHtmlUnsafeJsonChar);
}

/**
 * Minimal escaping for JSON that is only ever embedded as the content of a
 * classic inline <script> element. The HTML spec only forbids "<!--",
 * "<script" and "</script" (ASCII case-insensitive) in script content, so
 * only a '<' that begins one of those is escaped; '>' and '&' have no
 * meaning there.
 * https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 *
 * Used for the large RSC payload chunks: leaving markup such as "<p>" intact
 * lets compression match it against the identical SSR markup. Do not use
 * this for values that can land outside a script element.
 */
const SCRIPT_UNSAFE_JSON_CHARS_RE = /<(?=!--|\/?script)|[\u2028\u2029]/gi;

export function scriptSafeJsonStringify(data: unknown): string {
  const json = JSON.stringify(data);
  if (json === undefined) throw new TypeError("Cannot serialize value as JSON");
  return json.replace(SCRIPT_UNSAFE_JSON_CHARS_RE, escapeHtmlUnsafeJsonChar);
}

export function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const HTML_SPACE_RE = /[\t\n\f\r ]+/;

export function htmlTokenListContains(value: string | null, token: string): boolean {
  if (value === null) return false;

  return value
    .split(HTML_SPACE_RE)
    .some((part) => part.length > 0 && part.toLowerCase() === token.toLowerCase());
}

export function createNonceAttribute(nonce?: string): string {
  if (!nonce) {
    return "";
  }

  return ` nonce="${escapeHtmlAttr(nonce)}"`;
}

export function createInlineScriptTag(content: string, nonce?: string): string {
  return `<script${createNonceAttribute(nonce)}>${content}</script>`;
}
