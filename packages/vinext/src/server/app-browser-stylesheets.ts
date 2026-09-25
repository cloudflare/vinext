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
const requestedStylesheets = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();

// The literal URL prefix server stylesheet hrefs start with when `assetPrefix`
// is configured (see `resolveAssetUrlPrefix`), or "" when they are `base` +
// file. Inlined at build time.
const ASSET_URL_PREFIX = process.env.__VINEXT_ASSET_URL_PREFIX ?? "";

/**
 * Convert the absolute URL Vite's preload helper resolves back to the literal
 * href the server rendered for the same stylesheet. React keys stylesheet
 * resources by that literal string, so any other spelling of the same URL is
 * inserted a second time.
 *
 * With an `assetPrefix`, plugin-rsc renders `assetUrlPrefix + file`, which may
 * be absolute, protocol-relative or root-relative. Otherwise it renders
 * `base + file`: root-relative for same-origin assets. `pageUrl` is the page's
 * own URL (not `document.baseURI`, which a `<base>` element can point at
 * another origin).
 */
export function toDocumentStylesheetHref(
  url: string,
  pageUrl: string,
  assetUrlPrefix = "",
): string {
  const resolved = new URL(url, pageUrl);
  if (assetUrlPrefix) {
    const prefix = new URL(assetUrlPrefix, pageUrl).href;
    if (resolved.href.startsWith(prefix)) {
      return assetUrlPrefix + resolved.href.slice(prefix.length);
    }
  }
  if (resolved.origin !== new URL(pageUrl).origin) return resolved.href;
  return resolved.pathname + resolved.search + resolved.hash;
}

/**
 * Fetch a stylesheet without applying it. React's `preload()` returns nothing
 * to wait on, so insert the hint here; `preload()` then finds it by href
 * instead of inserting a second one.
 */
function fetchStylesheet(url: string, href: string, nonce: string | undefined): Promise<void> {
  const link = document.createElement("link");
  link.rel = "preload";
  link.as = "style";
  link.crossOrigin = "";
  link.href = href;
  if (nonce) link.setAttribute("nonce", nonce);
  const loaded = new Promise<void>((resolve, reject) => {
    link.addEventListener("load", () => resolve());
    // Same failure Vite's helper reports, so `vite:preloadError` still fires.
    link.addEventListener("error", () => reject(new Error(`Unable to preload CSS for ${url}`)));
  });
  document.head.appendChild(link);
  return loaded;
}

function loadAppStylesheet(url: string, nonce?: string): Promise<void> {
  const href = toDocumentStylesheetHref(url, location.href, ASSET_URL_PREFIX);
  const requested = requestedStylesheets.get(href);
  if (requested) return requested;
  const stylesheetNonce = nonce || undefined;
  // Vite's helper waits for a chunk's CSS before evaluating the chunk, so the
  // component never renders unstyled. Keep that: the returned promise settles
  // once the file is fetched, and React applies it when it commits the link.
  const loaded = fetchStylesheet(url, href, stylesheetNonce);
  requestedStylesheets.set(href, loaded);
  // Let a retried import (e.g. next/dynamic's `retry`) fetch again instead of
  // replaying the failure.
  void loaded.catch(() => {
    if (requestedStylesheets.get(href) === loaded) requestedStylesheets.delete(href);
  });
  if (stylesheets.some((stylesheet) => stylesheet.href === href)) return loaded;
  // Registering the hint with React makes the stylesheet resource wait for
  // the stylesheet itself (not just the hint) before a transition commits.
  preload(href, { as: "style", crossOrigin: "", nonce: stylesheetNonce });
  stylesheets = [...stylesheets, { href, nonce: stylesheetNonce }];
  for (const listener of listeners) listener();
  return loaded;
}

export function installAppStylesheetLoader(): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(APP_STYLESHEET_LOADER_KEY)] =
    loadAppStylesheet;
}

export function AppClientStylesheets(): ReactNode {
  const [rendered, setRendered] = useState(stylesheets);
  useEffect(() => {
    // When a lazy component starts the import during a render, React gives
    // this update the lanes being rendered, so the stylesheet commits with the
    // tree that needs it. Otherwise the transition still holds the commit
    // until the stylesheet has loaded.
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
