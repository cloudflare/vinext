import {
  getDocumentHeadOpenMarker,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";
import { escapeHtmlAttr } from "./html.js";

export type DocumentAssetProps = {
  headNonce?: string;
  headCrossOrigin?: string;
  scriptNonce?: string;
  scriptCrossOrigin?: string;
};

type ApplyDocumentAssetPropsOptions = {
  configuredCrossOrigin?: string;
  protectedAssetMarker?: string;
  scriptOwner?: "head" | "next-script";
};

const HEAD_NONCE_ATTR = "data-vinext-head-nonce";
const HEAD_CROSS_ORIGIN_ATTR = "data-vinext-head-cross-origin";
const SCRIPT_NONCE_ATTR = "data-vinext-script-nonce";
const SCRIPT_CROSS_ORIGIN_ATTR = "data-vinext-script-cross-origin";
function readAttribute(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined;
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match?.[1];
}

function removeAttributes(tag: string, names: readonly string[]): string {
  return tag.replace(new RegExp(`\\s(?:${names.join("|")})="[^"]*"`, "g"), "");
}

type TagRange = { start: number; end: number };

/** The `<tagName ...>` opening tag that ends right before `index`. */
function findOpeningTagEndingAt(html: string, tagName: string, index: number): TagRange | null {
  const start = html.lastIndexOf(`<${tagName}`, index);
  if (start === -1) return null;
  const tag = html.slice(start, index);
  return new RegExp(`^<${tagName}\\b[^>]*>$`, "i").test(tag) ? { start, end: index } : null;
}

function locateHeadTag(html: string, token: string): TagRange | null {
  const markerIndex = html.indexOf(getDocumentHeadOpenMarker(token));
  if (markerIndex === -1) return null;
  const start = html.lastIndexOf("<head", markerIndex);
  return start === -1 ? null : { start, end: markerIndex };
}

function locateNextScriptTag(html: string, token: string): TagRange | null {
  const placeholderIndex = html.indexOf(getDocumentScriptsPlaceholder(token));
  return placeholderIndex === -1 ? null : findOpeningTagEndingAt(html, "span", placeholderIndex);
}

/**
 * Read the asset props `<Head>` and `<NextScript />` carry as marker
 * attributes, located through this render's placeholders, and strip them.
 */
export function extractDocumentAssetProps(
  html: string,
  token: string,
): {
  html: string;
  props: DocumentAssetProps;
} {
  const headRange = locateHeadTag(html, token);
  const nextScriptRange = locateNextScriptTag(html, token);
  const headTag = headRange ? html.slice(headRange.start, headRange.end) : undefined;
  const nextScriptTag = nextScriptRange
    ? html.slice(nextScriptRange.start, nextScriptRange.end)
    : undefined;
  const props = {
    headNonce: readAttribute(headTag, HEAD_NONCE_ATTR),
    headCrossOrigin: readAttribute(headTag, HEAD_CROSS_ORIGIN_ATTR),
    scriptNonce: readAttribute(nextScriptTag, SCRIPT_NONCE_ATTR),
    scriptCrossOrigin: readAttribute(nextScriptTag, SCRIPT_CROSS_ORIGIN_ATTR),
  };
  // Edit the later tag first so the earlier range stays valid.
  const edits = [
    headRange && { range: headRange, names: [HEAD_NONCE_ATTR, HEAD_CROSS_ORIGIN_ATTR] },
    nextScriptRange && {
      range: nextScriptRange,
      names: [SCRIPT_NONCE_ATTR, SCRIPT_CROSS_ORIGIN_ATTR],
    },
  ]
    .filter((edit) => edit !== null)
    .sort((a, b) => b.range.start - a.range.start);
  let cleanedHtml = html;
  for (const { range, names } of edits) {
    cleanedHtml =
      cleanedHtml.slice(0, range.start) +
      removeAttributes(cleanedHtml.slice(range.start, range.end), names) +
      cleanedHtml.slice(range.end);
  }
  return { html: cleanedHtml, props };
}

function addAttribute(
  tag: string,
  name: string,
  value: string | undefined,
  replaceExisting = false,
): string {
  if (value === undefined) return tag;
  const attributePattern = new RegExp(`\\s${name}(?:="[^"]*")?`, "i");
  if (attributePattern.test(tag)) {
    return replaceExisting
      ? tag.replace(attributePattern, () => ` ${name}="${escapeHtmlAttr(value)}"`)
      : tag;
  }
  if (!tag.endsWith(">")) return tag;
  const selfClosing = tag.endsWith("/>");
  const closingStart = selfClosing ? tag.length - 2 : tag.length - 1;
  const opening = tag.slice(0, closingStart).trimEnd();
  const closing = selfClosing ? " />" : ">";
  return `${opening} ${name}="${escapeHtmlAttr(value)}"${closing}`;
}

function hasAttribute(tag: string, name: string | undefined): boolean {
  return name !== undefined && new RegExp(`\\s${name}(?:="[^"]*")?`, "i").test(tag);
}

/**
 * Protect asset tags whose attributes already have a more specific owner while
 * Vite runs its HTML transforms. Tags injected by Vite after this marker pass
 * remain unmarked, so Document/config props can still be applied to them.
 */
export function markDocumentAssetPropsProtectedTags(html: string, markerAttribute: string): string {
  return html
    .replace(/<script\b[^>]*>/gi, (tag) => addAttribute(tag, markerAttribute, ""))
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) =>
      addAttribute(tag, markerAttribute, ""),
    );
}

export function stripDocumentAssetPropsProtectionMarkers(
  html: string,
  markerAttribute: string,
): string {
  const stripMarker = (tag: string) => removeAttributes(tag, [markerAttribute]);
  return html
    .replace(/<script\b[^>]*>/gi, stripMarker)
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, stripMarker);
}

export function applyDocumentAssetProps(
  html: string,
  props: DocumentAssetProps,
  options: ApplyDocumentAssetPropsOptions = {},
): string {
  const scriptOwner = options.scriptOwner ?? "next-script";
  const scriptNonce = scriptOwner === "head" ? props.headNonce : props.scriptNonce;
  const preloadNonce = props.headNonce;
  const scriptCrossOrigin =
    (scriptOwner === "head" ? props.headCrossOrigin : props.scriptCrossOrigin) ??
    options.configuredCrossOrigin;
  const preloadCrossOrigin = props.headCrossOrigin ?? options.configuredCrossOrigin;

  return html
    .replace(/<script\b[^>]*>/gi, (tag) => {
      if (hasAttribute(tag, options.protectedAssetMarker)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", scriptNonce, true),
        "crossorigin",
        scriptCrossOrigin,
        true,
      );
    })
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) => {
      if (hasAttribute(tag, options.protectedAssetMarker)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", preloadNonce, true),
        "crossorigin",
        preloadCrossOrigin,
        true,
      );
    });
}
