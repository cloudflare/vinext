import { escapeHtmlAttr } from "./html.js";

export type DocumentAssetProps = {
  headNonce?: string;
  headCrossOrigin?: string;
  scriptNonce?: string;
  scriptCrossOrigin?: string;
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

export function extractDocumentAssetProps(html: string): {
  html: string;
  props: DocumentAssetProps;
} {
  const headTag = html.match(/<head\b[^>]*>/i)?.[0];
  const nextScriptTag = html.match(/<span\b[^>]*>(?=<!-- __NEXT_SCRIPTS__ -->)/i)?.[0];
  const props = {
    headNonce: readAttribute(headTag, HEAD_NONCE_ATTR),
    headCrossOrigin: readAttribute(headTag, HEAD_CROSS_ORIGIN_ATTR),
    scriptNonce: readAttribute(nextScriptTag, SCRIPT_NONCE_ATTR),
    scriptCrossOrigin: readAttribute(nextScriptTag, SCRIPT_CROSS_ORIGIN_ATTR),
  };
  const cleanedHtml = html
    .replace(/<head\b[^>]*>/i, (tag) =>
      removeAttributes(tag, [HEAD_NONCE_ATTR, HEAD_CROSS_ORIGIN_ATTR]),
    )
    .replace(/<span\b[^>]*>(?=<!-- __NEXT_SCRIPTS__ -->)/i, (tag) =>
      removeAttributes(tag, [SCRIPT_NONCE_ATTR, SCRIPT_CROSS_ORIGIN_ATTR]),
    );
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
      ? tag.replace(attributePattern, ` ${name}="${escapeHtmlAttr(value)}"`)
      : tag;
  }
  return tag.replace(/\s*\/?>$/, (ending) => {
    const closing = ending.includes("/") ? " />" : ">";
    return ` ${name}="${escapeHtmlAttr(value)}"${closing}`;
  });
}

function hasAttribute(tag: string, name: string | undefined): boolean {
  return name !== undefined && new RegExp(`\\s${name}(?:="[^"]*")?`, "i").test(tag);
}

/**
 * Protect user-authored `_document` and `next/head` asset tags while Vite runs
 * its HTML transforms. Tags injected by Vite after this marker pass remain
 * unmarked, so the framework props can be applied to them without overwriting
 * explicit attributes on user tags.
 */
export function markDocumentAuthoredAssetTags(html: string, markerAttribute: string): string {
  return html
    .replace(/<script\b[^>]*>/gi, (tag) => addAttribute(tag, markerAttribute, ""))
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) =>
      addAttribute(tag, markerAttribute, ""),
    );
}

export function stripDocumentAuthoredAssetMarkers(html: string, markerAttribute: string): string {
  const stripMarker = (tag: string) => removeAttributes(tag, [markerAttribute]);
  return html
    .replace(/<script\b[^>]*>/gi, stripMarker)
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, stripMarker);
}

export function applyDocumentAssetProps(
  html: string,
  props: DocumentAssetProps,
  configuredCrossOrigin?: string,
  documentAuthoredAssetMarker?: string,
): string {
  const scriptNonce = props.scriptNonce;
  const preloadNonce = props.headNonce;
  const scriptCrossOrigin = props.scriptCrossOrigin ?? configuredCrossOrigin;
  const preloadCrossOrigin = props.headCrossOrigin ?? configuredCrossOrigin;

  return html
    .replace(/<script\b[^>]*>/gi, (tag) => {
      if (hasAttribute(tag, documentAuthoredAssetMarker)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", scriptNonce, true),
        "crossorigin",
        scriptCrossOrigin,
        true,
      );
    })
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) => {
      if (hasAttribute(tag, documentAuthoredAssetMarker)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", preloadNonce, true),
        "crossorigin",
        preloadCrossOrigin,
        true,
      );
    });
}
