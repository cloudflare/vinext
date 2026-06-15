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

export function applyDocumentAssetProps(
  html: string,
  props: DocumentAssetProps,
  configuredCrossOrigin?: string,
): string {
  const scriptNonce = props.scriptNonce;
  const preloadNonce = props.headNonce;
  const scriptCrossOrigin = props.scriptCrossOrigin ?? configuredCrossOrigin;
  const preloadCrossOrigin =
    props.headCrossOrigin ?? props.scriptCrossOrigin ?? configuredCrossOrigin;

  return html
    .replace(/<script\b[^>]*>/gi, (tag) =>
      addAttribute(
        addAttribute(tag, "nonce", scriptNonce, true),
        "crossorigin",
        scriptCrossOrigin,
        true,
      ),
    )
    .replace(/<link\b[^>]*\brel="(?:preload|modulepreload)"[^>]*>/gi, (tag) =>
      addAttribute(
        addAttribute(tag, "nonce", preloadNonce, true),
        "crossorigin",
        preloadCrossOrigin,
        true,
      ),
    );
}
