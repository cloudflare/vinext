"use client";

import { useLayoutEffect } from "react";
import { preload } from "react-dom";

/**
 * The `next/font` rules and preloads of an App Router route's server
 * components. The document carries them in its `<style data-vinext-fonts>`
 * block. The RSC payload carries them too, so a client navigation can add the
 * ones the document lacks: those server components never run in the browser.
 */
export type AppRouteFonts = {
  styles: readonly string[];
  preloads: readonly { href: string; type: string }[];
  links: readonly string[];
};

function documentHasStyle(css: string): boolean {
  for (const style of document.querySelectorAll("style")) {
    if (style.textContent?.includes(css)) return true;
  }
  return false;
}

function documentHasStylesheet(href: string): boolean {
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    if (link.getAttribute("href") === href) return true;
  }
  return false;
}

/**
 * The nonce the document's own font or inline styles carry, for a CSP; else
 * its scripts' one, as a document without fonts may have no style to copy.
 */
function documentStyleNonce(): string {
  for (const selector of ["style[data-vinext-fonts]", "style[nonce]", "script[nonce]"]) {
    const nonce = document.querySelector<HTMLElement>(selector)?.nonce;
    if (nonce) return nonce;
  }
  return "";
}

/** Add the route's font rules, stylesheets and preloads the document lacks. */
export function insertRouteFonts(fonts: AppRouteFonts): void {
  const nonce = documentStyleNonce();
  for (const href of fonts.links) {
    if (documentHasStylesheet(href)) continue;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    if (nonce) link.nonce = nonce;
    document.head.appendChild(link);
  }
  for (const { href, type } of fonts.preloads) {
    preload(href, { as: "font", type, crossOrigin: "" });
  }
  const missing = fonts.styles.filter((css) => !documentHasStyle(css));
  if (missing.length === 0) return;
  const style = document.createElement("style");
  style.setAttribute("data-vinext-fonts", "");
  if (nonce) style.nonce = nonce;
  style.textContent = missing.join("\n");
  document.head.appendChild(style);
}

/**
 * Renders nothing. On the client it adds the route's font rules the document
 * lacks, after a client navigation to the route. The document that the
 * server rendered for the route already has them, so hydration adds nothing.
 */
export function RouteFontsInsertion(fonts: AppRouteFonts) {
  // A payload re-renders the route with equal fonts in a new object.
  const key = JSON.stringify(fonts);
  useLayoutEffect(() => insertRouteFonts(JSON.parse(key) as AppRouteFonts), [key]);
  return null;
}
