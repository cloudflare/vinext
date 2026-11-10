import type { BeforeInteractiveInlineScript } from "vinext/shims/before-interactive-context";
import { createNonceAttribute, escapeHtmlAttr, safeJsonStringify } from "./html.js";

// Conservative subset of the HTML attribute-name grammar. Must start with a
// letter and contain only letters, digits, underscores, hyphens, or dots —
// enough to round-trip data-* and standard attributes (`async`, `defer`,
// `type`, `crossorigin`, etc.) without ever splicing a `"`/`>`/whitespace
// into the unquoted *name* position where escaping wouldn't help. Inline
// scripts apply the same names with `setAttribute`, which throws on anything
// outside the attribute-name grammar.
const VALID_ATTR_NAME = /^[a-zA-Z][\w.-]*$/;

// React does not serialize string-valued event props, but this renderer emits
// raw HTML (src scripts) or `setAttribute` calls (inline scripts) and therefore
// has to preserve that safety boundary itself. HTML attribute names are
// case-insensitive, so reject every `on*` case variant.
const EVENT_HANDLER_ATTR_NAME = /^on/i;

// Inline bodies never reach the HTML as raw text. Next.js serializes App
// Router beforeInteractive scripts as `(self.__next_s=...).push(json)` with
// `htmlEscapeJsonString`, so `<`, `>` and `&` in the body become `\u003c`-style
// escapes (.nextjs-ref/packages/next/src/client/script.tsx). vinext encodes
// the body and attributes the same way, so no part of the body can be read
// as markup by the browser or by the stream transform's string searches
// (`</head>`, `</body></html>`, stylesheet links). The loader carries its own
// payload (`[[name, value], ...]` attribute pairs plus the body) and swaps
// itself for the real script element. A classic script runs on insertion, at
// the same point in the parse as a parser-inserted tag. A module script is
// inserted at the same point, ahead of vinext's parser-deferred bootstrap, so
// it is queued before hydration starts; like the scripts Next.js inserts from
// `appBootstrap`, it still waits for its own imports and can run after
// hydration starts. Clearing `async` before applying
// the attributes keeps modules in registration order unless the author asked
// for `async`. The first of any case-insensitive duplicate attribute wins, as
// when the parser reads the tag.
const INLINE_SCRIPT_LOADER =
  '(function(c,p,s){s=document.createElement("script");s.async=!1;p[0].forEach(function(a){s.hasAttribute(a[0])||s.setAttribute(a[0],a[1])});s.text=p[1];(c||{}).parentNode?c.replaceWith(s):document.head.appendChild(s)})';

/**
 * Collect the attributes that go on a hoisted `<script>`, in emit order: id,
 * src, nonce, the residual passthroughs, then Next.js's `data-nscript` marker.
 * Boolean attributes map to the empty string.
 */
function collectAttributes(script: BeforeInteractiveInlineScript): [string, string][] {
  const attrs: [string, string][] = [];
  if (script.id) attrs.push(["id", script.id]);
  if (script.src) attrs.push(["src", script.src]);
  if (script.nonce) attrs.push(["nonce", script.nonce]);
  if (script.attributes) {
    for (const [key, value] of Object.entries(script.attributes)) {
      // The *name* can't be escaped — a malformed key would break the tag —
      // so we gate at the boundary instead of trying to neutralise it.
      if (!VALID_ATTR_NAME.test(key)) continue;
      if (EVENT_HANDLER_ATTR_NAME.test(key)) continue;
      // We emit the `data-nscript` marker ourselves below; drop any
      // user-supplied one so the tag never carries a duplicate attribute.
      if (key === "data-nscript") continue;
      if (value === true) {
        attrs.push([key, ""]);
      } else if (typeof value === "string") {
        attrs.push([key, value]);
      }
    }
  }
  // Tag every hoisted script with Next.js's `data-nscript` marker. Next.js
  // applies `data-nscript="beforeInteractive"` to server-rendered
  // beforeInteractive scripts and the client dedupes against it
  // (.nextjs-ref/packages/next/src/client/script.tsx — `data-nscript` and
  // `addBeforeInteractiveToCache`). Emitting it keeps vinext's hoisted output
  // consistent with that DOM contract.
  attrs.push(["data-nscript", "beforeInteractive"]);
  return attrs;
}

/**
 * Render captured `<Script strategy="beforeInteractive">` scripts to HTML,
 * ready to splice immediately after `<head ...>` opens.
 *
 * External (`src`) scripts render as a plain `<script src>` tag with quoted
 * attributes and no body. Inline scripts render as a loader whose payload is
 * HTML-safe JSON (see `INLINE_SCRIPT_LOADER`); the loader itself carries the
 * nonce so it runs under the same CSP as the script it creates.
 *
 * Keeping this function in its own module makes the boundary obvious: anything
 * passed through here is being concatenated directly into HTML; treat the
 * inputs accordingly.
 */
export function renderBeforeInteractiveInlineScripts(
  scripts: readonly BeforeInteractiveInlineScript[],
): string {
  if (scripts.length === 0) return "";
  let html = "";
  for (const script of scripts) {
    const attrs = collectAttributes(script);
    if (script.content === undefined) {
      let attrHtml = "";
      for (const [key, value] of attrs) {
        attrHtml += value === "" ? ` ${key}` : ` ${key}="${escapeHtmlAttr(value)}"`;
      }
      html += `<script${attrHtml}></script>`;
      continue;
    }
    const payload = safeJsonStringify([attrs, script.content]);
    html += `<script${createNonceAttribute(script.nonce)}>${INLINE_SCRIPT_LOADER}(document.currentScript,${payload})</script>`;
  }
  return html;
}
