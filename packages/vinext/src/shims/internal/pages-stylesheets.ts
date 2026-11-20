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
let removableLinkUrls: Set<string> | undefined;
let sharedLinkUrls: Set<string> | undefined;
// Links of a dynamic import's stylesheets that a page's commit put ahead of
// the marker.
const linksAheadOfMarker = new Set<HTMLLinkElement>();
// Where Vite added each of those links, among the dynamic imports' others.
const linkSlots = new WeakMap<HTMLLinkElement, Comment>();
// Where a link that the next commit creates for a stylesheet would have been
// added: as the page's stylesheets load, before its dynamic imports' ones.
const createdLinkSlots = new Map<string, Comment>();

// `url()`s that resolve against the stylesheet: not root-relative, not a
// fragment, and without a scheme.
const RELATIVE_CSS_URL = /url\(\s*(["']?)(?![/#]|[a-z][a-z\d+.-]*:)([^"'()\\\s]+)\1\s*\)/gi;

/**
 * Resolves the relative `url()`s of a stylesheet's text against its URL, as a
 * `<style>` tag resolves them against the page's. Vite emits these with a
 * relative `base`.
 */
export function withAbsoluteUrls(text: string, href: string): string {
  return text.replace(
    RELATIVE_CSS_URL,
    (_match, _quote, url: string) => `url(${JSON.stringify(new URL(url, href).href)})`,
  );
}

function fetchStylesheet(href: string): Promise<PagesStylesheet> {
  let text = stylesheetTexts.get(href);
  if (!text) {
    text = fetch(href, { credentials: "same-origin" }).then((res) => {
      if (!res.ok) throw new Error(`Failed to load stylesheet: ${href}`);
      const url = res.url || new URL(href, document.baseURI).href;
      return res.text().then((content) => ({ href, text: withAbsoluteUrls(content, url) }));
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

// A stylesheet's URL, short of its fragment, as `renderBuiltUrl` can tell
// stylesheets apart by origin or query.
function urlOf(href: string): string {
  try {
    const url = new URL(href, document.baseURI);
    url.hash = "";
    return url.href;
  } catch {
    return href;
  }
}

function linkUrls(): { removable: Set<string>; shared: Set<string> } {
  if (!removableLinkUrls || !sharedLinkUrls) {
    const manifest = window.__VINEXT_PAGE_STYLESHEETS__;
    const shared = new Set(manifest?.shared.map(urlOf));
    sharedLinkUrls = shared;
    removableLinkUrls = new Set(
      Object.values(manifest?.routes ?? {})
        .flat()
        .map(urlOf)
        .filter((url) => !shared.has(url)),
    );
  }
  return { removable: removableLinkUrls, shared: sharedLinkUrls };
}

/** Adds the stylesheets that the document lacks, turned off. */
export function insertPagesStylesheets(stylesheets: readonly PagesStylesheet[]): void {
  for (const slot of createdLinkSlots.values()) slot.remove();
  createdLinkSlots.clear();
  const { shared } = linkUrls();
  const linked = new Set(
    Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'), (link) =>
      urlOf(link.href),
    ),
  );
  for (const { href } of stylesheets) {
    const url = urlOf(href);
    if (!shared.has(url) || linked.has(url)) continue;
    const slot = document.createComment("");
    document.head.appendChild(slot);
    createdLinkSlots.set(url, slot);
  }

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
  const { removable, shared } = linkUrls();
  const isAheadOfMarker = (link: Element) =>
    (marker.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_PRECEDING) !== 0;
  const pageUrls = new Set(stylesheets.map(({ href }) => urlOf(href)));
  const links = new Map<string, HTMLLinkElement>();
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const url = urlOf(link.href);
    const isAhead = isAheadOfMarker(link);
    if (isAhead && removable.has(url)) {
      link.remove();
      continue;
    }
    links.set(url, link);
    // As the server links them.
    if (isAhead && shared.has(url)) linksAheadOfMarker.add(link);
  }
  for (const link of linksAheadOfMarker) {
    if (pageUrls.has(urlOf(link.href))) continue;
    linksAheadOfMarker.delete(link);
    if (!link.isConnected) continue;
    const slot = linkSlots.get(link);
    linkSlots.delete(link);
    if (slot?.isConnected) {
      slot.replaceWith(link);
    } else {
      reference.after(link);
      reference = link;
    }
  }
  const nonce = marker.getAttribute("data-n-css");
  for (const { href } of stylesheets) {
    const url = urlOf(href);
    let link = links.get(url);
    if (link && isAheadOfMarker(link)) continue;
    if (!link) {
      if (!shared.has(url)) continue;
      link = document.createElement("link");
      link.rel = "stylesheet";
      // As Vite links the stylesheets that a dynamic import loads.
      link.crossOrigin = "";
      link.setAttribute("href", href);
      if (nonce) link.setAttribute("nonce", nonce);
      const slot = createdLinkSlots.get(url);
      if (slot?.isConnected) {
        linkSlots.set(link, slot);
        createdLinkSlots.delete(url);
      }
    } else if (link.isConnected) {
      const slot = document.createComment("");
      link.replaceWith(slot);
      linkSlots.set(link, slot);
    }
    marker.parentNode!.insertBefore(link, marker);
    linksAheadOfMarker.add(link);
  }
  for (const slot of createdLinkSlots.values()) slot.remove();
  createdLinkSlots.clear();
}
