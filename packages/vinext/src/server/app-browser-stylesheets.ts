/**
 * App Router runtime for stylesheets requested by lazily loaded client chunks.
 *
 * The production preload helper hands these stylesheets to the loader
 * installed here (see `plugins/app-stylesheet-preload.ts`). They render as
 * React stylesheet resources from a component placed after the app tree, which
 * mirrors Next.js's `RuntimeStyles`: in a single commit the Server Component
 * stylesheets are inserted first, later additions append to their precedence
 * group, and a stylesheet the server already rendered is deduplicated by href.
 */
import { createElement, startTransition, useEffect, useState, type ReactNode } from "react";
import { preload } from "react-dom";
import { APP_STYLESHEET_LOADER_KEY } from "../utils/app-stylesheet-loader.js";

// Matches the precedence plugin-rsc uses when SSR preinitializes client
// reference stylesheets, so runtime-loaded client CSS joins the same group.
const CLIENT_STYLESHEET_PRECEDENCE = "vite-rsc/client-reference";

type ClientStylesheet = { href: string; nonce: string | undefined };

let stylesheets: readonly ClientStylesheet[] = [];
const requestedHrefs = new Set<string>();
const listeners = new Set<() => void>();

/**
 * Normalize a preload URL to the href string React's server-rendered
 * stylesheet resources use. Same-origin assets are root-relative (plugin-rsc
 * emits `base + file`), while cross-origin asset prefixes stay absolute.
 */
export function toDocumentStylesheetHref(url: string, documentUrl: string): string {
  const resolved = new URL(url, documentUrl);
  if (resolved.origin !== new URL(documentUrl).origin) return resolved.href;
  return resolved.pathname + resolved.search + resolved.hash;
}

function loadAppStylesheet(url: string, nonce?: string): void {
  const href = toDocumentStylesheetHref(url, document.baseURI);
  if (requestedHrefs.has(href)) return;
  requestedHrefs.add(href);
  // Vite's helper would have fetched the file before evaluating the chunk.
  // Start the fetch now; the stylesheet itself is applied when React commits it.
  preload(href, { as: "style", crossOrigin: "", nonce: nonce || undefined });
  stylesheets = [...stylesheets, { href, nonce: nonce || undefined }];
  for (const listener of listeners) listener();
}

export function installAppStylesheetLoader(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(APP_STYLESHEET_LOADER_KEY)] =
    loadAppStylesheet;
}

export function AppClientStylesheets(): ReactNode {
  const [rendered, setRendered] = useState(stylesheets);
  useEffect(() => {
    // A transition batches with the navigation that imported the chunk, so
    // React holds that commit until the new stylesheet has loaded.
    const update = () => startTransition(() => setRendered(stylesheets));
    listeners.add(update);
    // Pick up stylesheets requested between this render and the subscription.
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);

  return rendered.map(({ href, nonce }) =>
    createElement("link", {
      key: href,
      rel: "stylesheet",
      href,
      precedence: CLIENT_STYLESHEET_PRECEDENCE,
      crossOrigin: "",
      nonce,
    }),
  );
}
