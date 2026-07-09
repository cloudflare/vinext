import type { BeforeInteractiveInlineScript } from "vinext/shims/before-interactive-context";
import { createNonceAttribute, escapeHtmlAttr } from "./html.js";

// Conservative subset of the HTML attribute-name grammar. Must start with a
// letter and contain only letters, digits, underscores, hyphens, or dots —
// enough to round-trip data-* and standard attributes (`async`, `defer`,
// `type`, `crossorigin`, etc.) without ever splicing a `"`/`>`/whitespace
// into the unquoted *name* position where escaping wouldn't help.
const VALID_ATTR_NAME = /^[a-zA-Z][\w.-]*$/;

/**
 * Render captured `<Script strategy="beforeInteractive">` scripts to HTML,
 * ready to splice immediately after `<head ...>` opens. Each entry has already
 * had its inline content escaped via `escapeInlineContent(..., "script")`
 * inside the Script shim, so this function only quotes the attributes that
 * actually go on the tag (id, src, nonce, plus the residual passthroughs).
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
    let attrs = "";
    attrs += ` data-vinext-script-key="${escapeHtmlAttr(script.key)}"`;
    if (script.id) {
      attrs += ` id="${escapeHtmlAttr(script.id)}"`;
    }
    if (script.src) {
      attrs += ` src="${escapeHtmlAttr(script.src)}"`;
    }
    attrs += createNonceAttribute(script.nonce);
    if (script.attributes) {
      for (const [key, value] of Object.entries(script.attributes)) {
        // Attribute *values* go through escapeHtmlAttr below. The *name*
        // can't be escaped — a malformed key would break the tag — so we
        // gate at the boundary instead of trying to neutralise it.
        if (!VALID_ATTR_NAME.test(key)) continue;
        // We emit the `data-nscript` marker ourselves below; drop any
        // user-supplied one so the tag never carries a duplicate attribute.
        if (key === "data-nscript") continue;
        if (value === true) {
          attrs += ` ${key}`;
        } else if (typeof value === "string") {
          attrs += ` ${key}="${escapeHtmlAttr(value)}"`;
        }
      }
    }
    // Tag every hoisted script with Next.js's `data-nscript` marker. Next.js
    // applies `data-nscript="beforeInteractive"` to server-rendered
    // beforeInteractive scripts and the client dedupes against it
    // (.nextjs-ref/packages/next/src/client/script.tsx — `data-nscript` and
    // `addBeforeInteractiveToCache`). Emitting it keeps vinext's hoisted output
    // consistent with that DOM contract.
    attrs += ` data-nscript="beforeInteractive"`;
    // `innerHTML` is pre-escaped inline content; src scripts have none, so the
    // tag body is empty.
    html += `<script${attrs}>${script.innerHTML ?? ""}</script>`;
  }
  return html;
}

export function insertBeforeInteractiveScripts(
  html: string,
  scripts: readonly BeforeInteractiveInlineScript[],
): string {
  return insertAfterHeadOpen(html, renderBeforeInteractiveInlineScripts(scripts));
}

export function insertAfterHeadOpen(html: string, insertion: string): string {
  if (!insertion) return html;

  const headOpenIndex = html.indexOf("<head");
  const headOpenEnd = headOpenIndex === -1 ? -1 : html.indexOf(">", headOpenIndex + 5);
  if (headOpenEnd === -1) return html;

  return html.slice(0, headOpenEnd + 1) + insertion + html.slice(headOpenEnd + 1);
}
