import type { BeforeInteractiveInlineScript } from "vinext/shims/before-interactive-context";
import { BEFORE_INTERACTIVE_MODULES_GLOBAL } from "../client/browser-globals.js";
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
// the same point in the parse as a parser-inserted tag.
//
// Module scripts, inline or `src`, all go through the module loader so they
// share one queue: clearing `async` before applying the attributes keeps them
// in registration order unless the author asked for `async`. A parser-inserted
// `src` module would instead wait for parsing to finish and run after the
// created ones. Each created module also registers a promise, and the App
// Router bootstrap awaits them before it hydrates. This keeps the ordering
// Next.js gets from inserting its queue in sequence in `appBootstrap`, waiting
// on each external script, before it hydrates. A `src` module settles its
// promise on `load` or `error`. An inline module fires neither, so a one-line
// inline module queued right after it (same nonce, so CSP treats both alike)
// settles the promise by index once the inline one has run, then removes
// itself. Each also settles if CSP blocks it. The first of any
// case-insensitive duplicate attribute wins, as when the parser reads the tag.
const CLASSIC_SCRIPT_LOADER =
  '(function(c,p,s){s=document.createElement("script");s.async=!1;p[0].forEach(function(a){s.hasAttribute(a[0])||s.setAttribute(a[0],a[1])});s.text=p[1];(c||{}).parentNode?c.replaceWith(s):document.head.appendChild(s)})';
const MODULE_SCRIPT_LOADER = `(function(c,p,s,t,q,n,d){s=document.createElement("script");s.async=!1;p[0].forEach(function(a){s.hasAttribute(a[0])||s.setAttribute(a[0],a[1])});p[1]!=null?s.text=p[1]:0;(c||{}).parentNode?c.replaceWith(s):document.head.appendChild(s);q=self.${BEFORE_INTERACTIVE_MODULES_GLOBAL}=self.${BEFORE_INTERACTIVE_MODULES_GLOBAL}||[];n=q.length;q.push(new Promise(function(r){d=function(){t===s||t.remove();r()};t=s;if(p[1]!=null){t=document.createElement("script");t.async=!1;t.type="module";t.nonce=s.nonce;t.text="self.${BEFORE_INTERACTIVE_MODULES_GLOBAL}["+n+"].d()";s.after(t)}t.onload=t.onerror=t.onsecuritypolicyviolation=d}));q[n].d=d})`;

// The script `type` that makes the browser run it as a module: an exact,
// case-insensitive match. Any other non-JavaScript type is a data block that
// fires no events, so it must stay on the classic path, which never waits.
const MODULE_TYPE = /^module$/i;

function isModuleScript(attrs: readonly [string, string][]): boolean {
  const type = attrs.find(([name]) => name.toLowerCase() === "type");
  return type !== undefined && MODULE_TYPE.test(type[1]);
}

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
 * Classic external (`src`) scripts render as a plain `<script src>` tag with
 * quoted attributes and no body. Inline scripts and module scripts render as a
 * loader whose payload is HTML-safe JSON (see the loaders above); the loader
 * itself carries the nonce so it runs under the same CSP as the script it
 * creates.
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
    const isModule = isModuleScript(attrs);
    if (script.content === undefined && !isModule) {
      let attrHtml = "";
      for (const [key, value] of attrs) {
        attrHtml += value === "" ? ` ${key}` : ` ${key}="${escapeHtmlAttr(value)}"`;
      }
      html += `<script${attrHtml}></script>`;
      continue;
    }
    const loader = isModule ? MODULE_SCRIPT_LOADER : CLASSIC_SCRIPT_LOADER;
    const payload = safeJsonStringify([attrs, script.content ?? null]);
    html += `<script${createNonceAttribute(script.nonce)}>${loader}(document.currentScript,${payload})</script>`;
  }
  return html;
}
