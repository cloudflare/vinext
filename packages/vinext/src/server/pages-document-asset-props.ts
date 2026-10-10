import {
  getDocumentHeadOpenMarker,
  getDocumentScriptsPlaceholder,
} from "vinext/shims/document-placeholders";
import { escapeRegExp } from "../utils/regex.js";
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

/**
 * Read and strip the nonce and crossOrigin props that `<Head>` and
 * `<NextScript />` recorded on their tags, found by this render's token.
 */
export function extractDocumentAssetProps(
  html: string,
  token: string,
): {
  html: string;
  props: DocumentAssetProps;
} {
  const headTagPattern = new RegExp(
    `<head\\b[^>]*${escapeRegExp(getDocumentHeadOpenMarker(token))}[^>]*>`,
    "i",
  );
  const nextScriptTagPattern = new RegExp(
    `<span\\b[^>]*>(?=${escapeRegExp(getDocumentScriptsPlaceholder(token))})`,
    "i",
  );
  const headTag = html.match(headTagPattern)?.[0];
  const nextScriptTag = html.match(nextScriptTagPattern)?.[0];
  const props = {
    headNonce: readAttribute(headTag, HEAD_NONCE_ATTR),
    headCrossOrigin: readAttribute(headTag, HEAD_CROSS_ORIGIN_ATTR),
    scriptNonce: readAttribute(nextScriptTag, SCRIPT_NONCE_ATTR),
    scriptCrossOrigin: readAttribute(nextScriptTag, SCRIPT_CROSS_ORIGIN_ATTR),
  };
  const cleanedHtml = html
    .replace(headTagPattern, (tag) =>
      removeAttributes(tag, [HEAD_NONCE_ATTR, HEAD_CROSS_ORIGIN_ATTR]),
    )
    .replace(nextScriptTagPattern, (tag) =>
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
