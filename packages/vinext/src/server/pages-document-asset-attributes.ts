import { escapeRegExp } from "../utils/regex.js";
import { escapeHtmlAttr } from "./html.js";

export type PagesDocumentAssetAttributes = {
  nonce?: string;
  crossOrigin?: string;
};

const HEAD_MARKER_ATTR = "data-vinext-document-head";
const HEAD_NONCE_ATTR = "data-vinext-document-head-nonce";
const HEAD_CROSS_ORIGIN_ATTR = "data-vinext-document-head-crossorigin";
const NEXT_SCRIPT_MARKER_ATTR = "data-vinext-next-script";
const NEXT_SCRIPT_NONCE_ATTR = "data-vinext-next-script-nonce";
const NEXT_SCRIPT_CROSS_ORIGIN_ATTR = "data-vinext-next-script-crossorigin";
const NEXT_SCRIPT_PLACEHOLDER = "<!-- __NEXT_SCRIPTS__ -->";
const NEXT_SCRIPT_MARKER_PATTERN = new RegExp(
  `<span\\b(?=[^>]*\\b${escapeRegExp(NEXT_SCRIPT_MARKER_ATTR)}(?:\\s|=|>|\\/))[^>]*>\\s*${escapeRegExp(NEXT_SCRIPT_PLACEHOLDER)}\\s*<\\/span>`,
  "i",
);

function getHtmlAttribute(tag: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\s${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(pattern);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? undefined : decodeHtmlAttribute(value);
}

function hasHtmlAttribute(tag: string, name: string): boolean {
  return new RegExp(
    `\\s${escapeRegExp(name)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|/?>)`,
    "i",
  ).test(tag);
}

function removeHtmlAttribute(tag: string, name: string): string {
  return tag.replace(
    new RegExp(
      `\\s${escapeRegExp(name)}(?=\\s*=|\\s|/?>)(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
      "gi",
    ),
    "",
  );
}

function setHtmlAttribute(tag: string, name: string, value: string): string {
  const withoutExisting = removeHtmlAttribute(tag, name);
  const attr = ` ${name}="${escapeHtmlAttr(value)}"`;
  return withoutExisting.replace(/\s*\/?>$/, (closing) =>
    closing.endsWith("/>") ? `${attr} />` : `${attr}>`,
  );
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, "<")
    .replace(/&#60;/g, "<")
    .replace(/&#x3c;/gi, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#62;/g, ">")
    .replace(/&#x3e;/gi, ">")
    .replace(/&amp;/g, "&");
}

function normalizeCrossOrigin(value: string | undefined): string | undefined {
  return value === "anonymous" || value === "use-credentials" ? value : undefined;
}

function readAssetAttributes(
  tag: string,
  nonceAttr: string,
  crossOriginAttr: string,
): PagesDocumentAssetAttributes {
  return {
    nonce: getHtmlAttribute(tag, nonceAttr),
    crossOrigin: normalizeCrossOrigin(getHtmlAttribute(tag, crossOriginAttr)),
  };
}

function cleanMarkerAttributes(tag: string, names: string[]): string {
  return names.reduce((current, name) => removeHtmlAttribute(current, name), tag);
}

export function extractPagesDocumentAssetAttributes(html: string): {
  html: string;
  head: PagesDocumentAssetAttributes;
  nextScript: PagesDocumentAssetAttributes;
} {
  let head: PagesDocumentAssetAttributes = {};
  let nextScript: PagesDocumentAssetAttributes = {};

  let cleaned = html.replace(/<head\b[^>]*>/i, (tag) => {
    if (!hasHtmlAttribute(tag, HEAD_MARKER_ATTR)) return tag;

    head = readAssetAttributes(tag, HEAD_NONCE_ATTR, HEAD_CROSS_ORIGIN_ATTR);
    return cleanMarkerAttributes(tag, [HEAD_MARKER_ATTR, HEAD_NONCE_ATTR, HEAD_CROSS_ORIGIN_ATTR]);
  });

  cleaned = cleaned.replace(NEXT_SCRIPT_MARKER_PATTERN, (tag) => {
    nextScript = readAssetAttributes(tag, NEXT_SCRIPT_NONCE_ATTR, NEXT_SCRIPT_CROSS_ORIGIN_ATTR);
    return NEXT_SCRIPT_PLACEHOLDER;
  });

  return { html: cleaned, head, nextScript };
}

export function mergePagesDocumentAssetAttributes(
  documentAttrs: PagesDocumentAssetAttributes,
  fallbackAttrs: PagesDocumentAssetAttributes,
): PagesDocumentAssetAttributes {
  return {
    nonce: documentAttrs.nonce ?? fallbackAttrs.nonce,
    crossOrigin: documentAttrs.crossOrigin ?? fallbackAttrs.crossOrigin,
  };
}

export function applyPagesDocumentAssetAttributes(
  html: string,
  attrs: PagesDocumentAssetAttributes,
): string {
  if (!attrs.nonce && attrs.crossOrigin === undefined) return html;

  return html.replace(/<(script|link)\b[^>]*>/gi, (tag, tagName: string) => {
    if (tagName.toLowerCase() === "link") {
      const rel = getHtmlAttribute(tag, "rel")?.toLowerCase();
      if (rel !== "preload" && rel !== "modulepreload" && rel !== "stylesheet") {
        return tag;
      }
    }

    let next = tag;
    if (attrs.nonce) {
      next = setHtmlAttribute(next, "nonce", attrs.nonce);
    }
    if (attrs.crossOrigin !== undefined) {
      next = setHtmlAttribute(next, "crossorigin", attrs.crossOrigin);
    }
    return next;
  });
}
