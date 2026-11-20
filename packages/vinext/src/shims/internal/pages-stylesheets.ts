/**
 * Pages Router page stylesheets on client navigation.
 *
 * A production page's stylesheets stay in the document once loaded, so
 * without this an earlier page's rules would still apply, and in a different
 * order from that page's own load. As Next.js does, each navigation adds the
 * new page's stylesheets as `<style>` tags, turned off with `media="x"` until
 * the page commits; then only that page's are on, in its order, after
 * `noscript[data-n-css]`. The server-rendered `<link>`s for page stylesheets
 * go, as Next.js removes `link[data-n-p]`; the page loaders leave them out of
 * what Vite preloads.
 *
 * Ported from Next.js: packages/next/src/client/index.tsx (`doRender`:
 * `onStart`, `onHeadCommit`) and packages/next/src/client/route-loader.ts
 * (`fetchStyleSheet`).
 */

export type PagesStylesheet = { href: string; text: string };

const stylesheetTexts = new Map<string, Promise<PagesStylesheet>>();
let removableLinkPaths: Set<string> | undefined;
let sharedLinkPaths: Set<string> | undefined;
// Links of a dynamic import's stylesheets that a page's commit put ahead of
// the marker.
const linksAheadOfMarker = new Set<HTMLLinkElement>();

function fetchStylesheet(href: string): Promise<PagesStylesheet> {
  let text = stylesheetTexts.get(href);
  if (!text) {
    text = fetch(href, { credentials: "same-origin" }).then((res) => {
      if (!res.ok) throw new Error(`Failed to load stylesheet: ${href}`);
      return res.text().then((content) => ({ href, text: content }));
    });
    // Next.js keeps failures too; the navigation that hit one reloads the page.
    stylesheetTexts.set(href, text);
  }
  return text;
}

/**
 * Loads the stylesheets of the page that renders `route`. Resolves to
 * `undefined` without a production stylesheet list, as in development, where
 * Vite manages stylesheets.
 */
export function loadPagesRouteStylesheets(route: string): Promise<PagesStylesheet[]> | undefined {
  const manifest = typeof window === "undefined" ? undefined : window.__VINEXT_PAGE_STYLESHEETS__;
  if (!manifest) return undefined;
  return Promise.all((manifest.routes[route] ?? []).map(fetchStylesheet));
}

/** Adds the stylesheets that the document lacks, turned off. */
export function insertPagesStylesheets(stylesheets: readonly PagesStylesheet[]): void {
  const current = new Set(
    Array.from(document.querySelectorAll("style[data-n-href]"), (tag) =>
      tag.getAttribute("data-n-href"),
    ),
  );
  const nonce = document.querySelector("noscript[data-n-css]")?.getAttribute("data-n-css");
  for (const { href, text } of stylesheets) {
    if (current.has(href)) continue;
    const tag = document.createElement("style");
    tag.setAttribute("data-n-href", href);
    tag.setAttribute("media", "x");
    if (nonce) tag.setAttribute("nonce", nonce);
    document.head.appendChild(tag);
    tag.appendChild(document.createTextNode(text));
  }
}

function pathOf(href: string): string {
  try {
    return new URL(href, document.baseURI).pathname;
  } catch {
    return href;
  }
}

/**
 * Turns on `stylesheets` alone, in their order. Runs as the page commits,
 * before the browser paints it.
 */
export function commitPagesStylesheets(stylesheets: readonly PagesStylesheet[]): void {
  const desired = new Set(stylesheets.map((stylesheet) => stylesheet.href));
  const tags = new Map<string, Element>();
  for (const tag of document.querySelectorAll("style[data-n-href]")) {
    const href = tag.getAttribute("data-n-href")!;
    tags.set(href, tag);
    if (desired.has(href)) tag.removeAttribute("media");
    else tag.setAttribute("media", "x");
  }

  const marker = document.querySelector("noscript[data-n-css]");
  if (!marker) return;
  let reference = marker;
  for (const { href } of stylesheets) {
    const tag = tags.get(href);
    if (!tag) continue;
    marker.parentNode!.insertBefore(tag, reference.nextSibling);
    reference = tag;
  }

  // The `<style>` tags hold page stylesheets now, so their server-rendered
  // `<link>`s, ahead of the marker, go, except for stylesheets that other
  // dynamic imports load too. Those are linked ahead of the marker, as on a
  // full load: Vite's preload helper then finds the link when a dynamic import
  // loads one, rather than adding another after the page's own stylesheets,
  // and a link it added on an earlier page moves there. On a page that doesn't
  // load the stylesheet, such a link goes back after the page's own, where
  // Vite adds a dynamic import's stylesheets.
  const pagePaths = new Set(stylesheets.map(({ href }) => pathOf(href)));
  for (const link of linksAheadOfMarker) {
    if (pagePaths.has(pathOf(link.href))) continue;
    linksAheadOfMarker.delete(link);
    if (!link.isConnected) continue;
    reference.after(link);
    reference = link;
  }
  if (!removableLinkPaths || !sharedLinkPaths) {
    const manifest = window.__VINEXT_PAGE_STYLESHEETS__;
    sharedLinkPaths = new Set(manifest?.shared.map(pathOf));
    const shared = sharedLinkPaths;
    removableLinkPaths = new Set(
      Object.values(manifest?.routes ?? {})
        .flat()
        .map(pathOf)
        .filter((path) => !shared.has(path)),
    );
  }
  const isAheadOfMarker = (link: Element) =>
    (marker.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  const links = new Map<string, HTMLLinkElement>();
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const path = pathOf(link.href);
    if (isAheadOfMarker(link) && removableLinkPaths.has(path)) link.remove();
    else links.set(path, link);
  }
  const nonce = marker.getAttribute("data-n-css");
  for (const { href } of stylesheets) {
    const path = pathOf(href);
    let link = links.get(path);
    if (link && isAheadOfMarker(link)) continue;
    if (!link) {
      if (!sharedLinkPaths.has(path)) continue;
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("href", href);
      if (nonce) link.setAttribute("nonce", nonce);
    }
    marker.parentNode!.insertBefore(link, marker);
    linksAheadOfMarker.add(link);
  }
}
