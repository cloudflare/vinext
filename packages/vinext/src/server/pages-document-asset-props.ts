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
const DOCUMENT_AUTHORED_ASSET_ATTR = "data-vinext-document-authored-asset";

function readAttribute(html: string, name: string): string | undefined {
  const match = html.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match?.[1];
}

export function extractDocumentAssetProps(html: string): {
  html: string;
  props: DocumentAssetProps;
} {
  const props = {
    headNonce: readAttribute(html, HEAD_NONCE_ATTR),
    headCrossOrigin: readAttribute(html, HEAD_CROSS_ORIGIN_ATTR),
    scriptNonce: readAttribute(html, SCRIPT_NONCE_ATTR),
    scriptCrossOrigin: readAttribute(html, SCRIPT_CROSS_ORIGIN_ATTR),
  };
  const cleanedHtml = html.replace(
    new RegExp(
      `\\s(?:${HEAD_NONCE_ATTR}|${HEAD_CROSS_ORIGIN_ATTR}|${SCRIPT_NONCE_ATTR}|${SCRIPT_CROSS_ORIGIN_ATTR})="[^"]*"`,
      "g",
    ),
    "",
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

function isDocumentAuthoredAsset(tag: string): boolean {
  return new RegExp(`\\s${DOCUMENT_AUTHORED_ASSET_ATTR}(?:="[^"]*")?`, "i").test(tag);
}

/**
 * Protect user-authored `_document` and `next/head` asset tags while Vite runs
 * its HTML transforms. Tags injected by Vite after this marker pass remain
 * unmarked, so the framework props can be applied to them without overwriting
 * explicit attributes on user tags.
 */
export function markDocumentAuthoredAssetTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>/gi, (tag) => addAttribute(tag, DOCUMENT_AUTHORED_ASSET_ATTR, ""))
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) =>
      addAttribute(tag, DOCUMENT_AUTHORED_ASSET_ATTR, ""),
    );
}

export function stripDocumentAuthoredAssetMarkers(html: string): string {
  return html.replace(new RegExp(`\\s${DOCUMENT_AUTHORED_ASSET_ATTR}(?:="[^"]*")?`, "gi"), "");
}

export function applyDocumentAssetProps(
  html: string,
  props: DocumentAssetProps,
  configuredCrossOrigin?: string,
): string {
  const scriptNonce = props.scriptNonce;
  const preloadNonce = props.headNonce;
  const scriptCrossOrigin = props.scriptCrossOrigin ?? configuredCrossOrigin;
  const preloadCrossOrigin = props.headCrossOrigin ?? configuredCrossOrigin;

  return html
    .replace(/<script\b[^>]*>/gi, (tag) => {
      if (isDocumentAuthoredAsset(tag)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", scriptNonce, true),
        "crossorigin",
        scriptCrossOrigin,
        true,
      );
    })
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) => {
      if (isDocumentAuthoredAsset(tag)) return tag;
      return addAttribute(
        addAttribute(tag, "nonce", preloadNonce, true),
        "crossorigin",
        preloadCrossOrigin,
        true,
      );
    });
}
