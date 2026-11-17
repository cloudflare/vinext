/**
 * Stream the client references an SSR render may show before they load, and
 * link every client reference's scripts with the render's CSP nonce and the
 * configured crossOrigin, and its stylesheets with the configured crossOrigin.
 *
 * A render waits for its route's client references before it starts, except
 * those whose modules evaluate asynchronously (top-level await). Like Next.js,
 * it streams those: React suspends on one until it loads, showing the nearest
 * Suspense fallback first.
 *
 * plugin-rsc links a client module's stylesheets as the render reads its
 * exports, so a streamed module would link them wherever it rendered once
 * loaded, which depends on how long it took. Instead, a render links a
 * streamed reference's stylesheets in the route's import order, as Next.js's
 * Turbopack build does: just before the first reference after it links its
 * own, or after the shell's stylesheets when none does. Its scripts link as the
 * Flight stream names it.
 *
 * A module the render reads only after its shell has flushed, such as a page's
 * under loading.js, would only get a preload, and React would reveal it
 * unstyled. Next.js links each rendered segment's CSS, its Client Components'
 * included, whether they render or not, so a render links the stylesheets of
 * the references its rendered route files import statically the same way.
 * Next.js renders that CSS beside the segment, so React links it in the shell
 * when it reaches the segment before the shell flushes, and otherwise, below
 * a layout still pending then, holds the boundary's reveal for it instead of
 * the shell. A render does the same as it reaches the element that renders
 * each file (see `renderElementStylesheets`).
 *
 * plugin-rsc hints a client module's scripts without the render's nonce, which
 * a nonce-based CSP blocks, and always as anonymous, so under
 * `crossOrigin: "use-credentials"` the browser fetches the module the page
 * then imports without credentials. React keeps the first hint for each
 * script, so a render with either hints them first, with both, as Next.js does.
 * plugin-rsc also links its stylesheets as anonymous whatever the config, so a
 * render links them first with the configured crossOrigin too. Unlike Next.js,
 * it links them as anonymous when that's unset: Vite's preload helper always
 * links a lazily imported module's stylesheets as anonymous, and a later page
 * doing so would fail the CORS check on the no-cors copy the browser cached.
 */
import { createElement, type ReactNode } from "react";
import * as ReactDOM from "react-dom";
import { setOnClientReference } from "@vitejs/plugin-rsc/ssr";
import { getOrCreateAls } from "vinext/shims/internal/als-registry";
import { elementKey, type RouteClientReferenceSet } from "./app-client-reference-preloader.js";
import { escapeHtmlAttr } from "./html.js";
import { tagPromiseWithRequest } from "./isolate-shared-promise.js";
import type { AssetCrossOrigin } from "./pages-client-assets.js";

type AssetDeps = { js: string[]; css: string[] };
type ClientReferenceRequire = (id: string) => Promise<unknown>;
type ClientReferenceLoader = () => Promise<unknown>;

/** A render's streamed references, and the stylesheets the render linked. */
export type StreamedClientReferences = {
  /** The render's CSP nonce for the scripts it hints. */
  nonce: string | undefined;
  /** next.config's crossOrigin for the assets it links; "" when unset. */
  crossOrigin: AssetCrossOrigin;
  streamed: ReadonlySet<string>;
  /** Each of the route's references' position in the order its stylesheets link. */
  positions: ReadonlyMap<string, number>;
  /**
   * Streamed and linked references (see `RouteClientReferenceSet`) whose
   * stylesheets aren't linked yet, in the order `positions` gives.
   */
  unlinked: string[];
  linkedStylesheets: Set<string>;
  /** Each linked reference's elements (see `RouteClientReferenceSet.linkedElements`). */
  linkedElements: ReadonlyMap<string, readonly string[]>;
  /** The keys (see `elementKey`) of the elements in the render's payload. */
  payloadElements: Set<string>;
  /** The keys of the elements the render has reached. */
  renderedElements: Set<string>;
  /** Whether the shell's `<head>` has its stylesheets. */
  headLinked: boolean;
};

const WRAPPED = Symbol.for("vinext.streamedClientReferences.wrapped");
// Mirrors plugin-rsc's preloadDeps().
const STYLESHEET_PRECEDENCE = "vite-rsc/client-reference";

// Each reference's assets from plugin-rsc's assets manifest, reported as its
// load starts.
const referenceDeps = new Map<string, AssetDeps>();
const renderStorage = getOrCreateAls<StreamedClientReferences>("vinext.streamedClientReferences");

// plugin-rsc's own hints carry neither.
function hintsScripts(render: StreamedClientReferences): boolean {
  return !!render.nonce || render.crossOrigin === "use-credentials";
}

// Mirrors plugin-rsc's preloadDeps(), which leaves the client entry's own
// scripts at the default priority; the render has preinitialized those already.
function linkScripts(deps: AssetDeps, render: StreamedClientReferences): void {
  // React copies every option onto the link; its types leave out fetchPriority.
  const options = {
    as: "script",
    crossOrigin: render.crossOrigin,
    fetchPriority: "low",
    nonce: render.nonce,
  } as ReactDOM.PreloadModuleOptions;
  for (const href of deps.js) ReactDOM.preloadModule(href, options);
}

function linkStylesheets(hrefs: readonly string[], render: StreamedClientReferences): void {
  const options: ReactDOM.PreinitOptions = {
    as: "style",
    crossOrigin: render.crossOrigin,
    precedence: STYLESHEET_PRECEDENCE,
  };
  for (const href of hrefs) ReactDOM.preinit(href, options);
}

/**
 * Whether the render has reached an element rendering a file that imports
 * linked reference `id`. One the payload lacks counts as reached, since the
 * render can't tell when it would.
 */
function isReached(render: StreamedClientReferences, id: string): boolean {
  const elements = render.linkedElements.get(id);
  return (
    !elements ||
    elements.some((key) => render.renderedElements.has(key) || !render.payloadElements.has(key))
  );
}

/**
 * Before reference `id` links its stylesheets, link those of the streamed and
 * linked references that come before it in import order, except linked ones
 * the render hasn't reached yet.
 */
function linkStreamedStylesheetsBefore(render: StreamedClientReferences, id: string): void {
  const position = render.positions.get(id);
  if (position === undefined) return;
  const unreached: string[] = [];
  while (render.unlinked.length > 0 && render.positions.get(render.unlinked[0]!)! < position) {
    const unlinked = render.unlinked.shift()!;
    if (!isReached(render, unlinked)) {
      unreached.push(unlinked);
      continue;
    }
    const hrefs = referenceDeps.get(unlinked)?.css ?? [];
    for (const href of hrefs) render.linkedStylesheets.add(href);
    linkStylesheets(hrefs, render);
  }
  render.unlinked.unshift(...unreached);
}

/**
 * Wrap plugin-rsc's client-reference loader before any client reference
 * loads; a production build calls this as its SSR entry starts. `asyncIds` are
 * the references any route may stream, and `getLoader` returns a reference's
 * own loader from the client-references module.
 */
export function wrapClientReferenceRequire(
  asyncIds: ReadonlySet<string>,
  getLoader: (id: string) => ClientReferenceLoader | undefined,
): void {
  const load: ClientReferenceRequire | undefined = globalThis.__vite_rsc_client_require__;
  if (typeof load !== "function" || WRAPPED in load) return;
  setOnClientReference(({ id, deps }) => {
    referenceDeps.set(id, deps);
    const render = renderStorage.getStore();
    if (render && !render.streamed.has(id)) {
      for (const href of deps.css) render.linkedStylesheets.add(href);
    }
  });
  // One promise per reference, which React's Flight client tracks the
  // module's load state on. Every render in the isolate awaits it, so it
  // carries the tag of the request that starts the load.
  const loads = new Map<string, Promise<unknown>>();
  const wrapped: ClientReferenceRequire = (id) => {
    // The Flight client asks for a module as it reads the row naming it.
    const render = renderStorage.getStore();
    if (render?.streamed.has(id)) {
      const deps = referenceDeps.get(id);
      if (deps) linkScripts(deps, render);
    }
    let loading = loads.get(id);
    if (!loading) {
      const loader = asyncIds.has(id) ? getLoader(id) : undefined;
      loading = tagPromiseWithRequest(
        Promise.all([load(id), loader?.()]).then(
          ([mod, exports]) =>
            new Proxy(mod as object, {
              get(target, key, receiver) {
                const render = renderStorage.getStore();
                if (render) {
                  // A streamed reference reads its exports past plugin-rsc's
                  // module proxy, which would link its stylesheets here.
                  if (exports !== undefined && render.streamed.has(id)) {
                    return Reflect.get(exports as object, key);
                  }
                  linkStreamedStylesheetsBefore(render, id);
                  // plugin-rsc links the module's assets as it's read, after this.
                  const deps = referenceDeps.get(id);
                  if (deps && key in target) {
                    linkStylesheets(deps.css, render);
                    if (hintsScripts(render)) linkScripts(deps, render);
                  }
                }
                return Reflect.get(target, key, receiver);
              },
            }),
        ),
      );
      loads.set(id, loading);
    }
    return loading;
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  globalThis.__vite_rsc_client_require__ = wrapped;
}

/**
 * The route's references in the order their stylesheets link: import order,
 * with the linked references in their own order (a boundary may preload one a
 * page imports last first), each in a place one of them had.
 */
function stylesheetOrder(route: RouteClientReferenceSet | undefined): string[] {
  if (!route) return [];
  const linked = new Set(route.linked);
  let next = 0;
  return route.references.map((id) => (linked.has(id) ? route.linked[next++]! : id));
}

// The references whose stylesheets a render links, rendered or not.
function unlinkedReferences(
  route: RouteClientReferenceSet | undefined,
  streamed: ReadonlySet<string>,
): string[] {
  if (!route) return [];
  const linked = new Set(route.linked);
  return stylesheetOrder(route).filter((id) => streamed.has(id) || linked.has(id));
}

// The elements of the references whose stylesheets a render links, rendered
// or not.
function linkedElements(
  route: RouteClientReferenceSet | undefined,
): Map<string, readonly string[]> {
  if (!route) return new Map();
  return new Map(
    route.linked.flatMap((id) => {
      const elements = route.linkedElements.get(id);
      return elements ? [[id, elements] as const] : [];
    }),
  );
}

export function createStreamedClientReferences(
  route: RouteClientReferenceSet | undefined,
  nonce: string | undefined,
  crossOrigin: AssetCrossOrigin,
): StreamedClientReferences {
  const streamed = new Set(route?.streamed);
  return {
    nonce,
    crossOrigin,
    streamed,
    positions: new Map(stylesheetOrder(route).map((id, index) => [id, index])),
    unlinked: unlinkedReferences(route, streamed),
    linkedStylesheets: new Set(),
    linkedElements: linkedElements(route),
    payloadElements: new Set(),
    renderedElements: new Set(),
    headLinked: false,
  };
}

/**
 * Forget the stylesheets a discarded render linked, so the render that
 * replaces it, from `route`'s references, links them again.
 */
export function resetStreamedClientReferences(
  render: StreamedClientReferences | null,
  route: RouteClientReferenceSet | undefined,
): void {
  if (!render) return;
  render.positions = new Map(stylesheetOrder(route).map((id, index) => [id, index]));
  render.unlinked = unlinkedReferences(route, render.streamed);
  render.linkedStylesheets.clear();
  render.linkedElements = linkedElements(route);
  render.payloadElements.clear();
  render.renderedElements.clear();
  render.headLinked = false;
}

/** Record the ids of the elements in the payload a render decoded. */
export function setPayloadElements(
  render: StreamedClientReferences,
  elementIds: Iterable<string>,
): void {
  for (const id of elementIds) render.payloadElements.add(elementKey(id));
}

/**
 * The stylesheets of the linked references the files element `elementId`
 * renders import, which the render reaches now. Before the shell's `<head>`
 * has its stylesheets, it gets them there. After, the element is below a
 * boundary that was still pending, so they're returned as React stylesheets,
 * which React attaches to the boundary's reveal, as Next.js's segment CSS.
 */
export function renderElementStylesheets(
  render: StreamedClientReferences,
  elementId: string,
): ReactNode {
  const key = elementKey(elementId);
  if (render.renderedElements.has(key)) return null;
  render.renderedElements.add(key);
  if (!render.headLinked) return null;
  const hrefs = new Set<string>();
  render.unlinked = render.unlinked.filter((id) => {
    if (!render.linkedElements.get(id)?.includes(key)) return true;
    for (const href of referenceDeps.get(id)?.css ?? []) hrefs.add(href);
    return false;
  });
  if (hrefs.size === 0) return null;
  // React links each once, and holds the boundary's reveal for those it
  // already linked too.
  return Array.from(hrefs, (href) =>
    createElement("link", {
      key: href,
      rel: "stylesheet",
      href,
      precedence: STYLESHEET_PRECEDENCE,
      crossOrigin: render.crossOrigin,
    }),
  );
}

/** Run a render, and the Flight stream it reads, with its streamed references. */
export function runWithStreamedClientReferences<R>(
  render: StreamedClientReferences,
  fn: () => R,
): R {
  return renderStorage.run(render, fn);
}

/**
 * The `<head>` links of the stylesheets a render's shell left unlinked, those
 * of streamed and linked references after every reference it rendered. Those
 * of linked references it hasn't reached stay unlinked, for the elements that
 * reach them later (see `renderElementStylesheets`).
 */
export function renderStreamedStylesheets(render: StreamedClientReferences): string {
  render.headLinked = true;
  const hrefs = new Set<string>();
  render.unlinked = render.unlinked.filter((id) => {
    if (!isReached(render, id)) return true;
    for (const href of referenceDeps.get(id)?.css ?? []) {
      if (!render.linkedStylesheets.has(href)) hrefs.add(href);
    }
    return false;
  });
  // React writes "" for anonymous.
  const crossOrigin = render.crossOrigin === "use-credentials" ? "use-credentials" : "";
  let html = "";
  for (const href of hrefs) {
    render.linkedStylesheets.add(href);
    html += `<link rel="stylesheet" href="${escapeHtmlAttr(href)}" data-precedence="${STYLESHEET_PRECEDENCE}" crossorigin="${crossOrigin}"/>`;
  }
  return html;
}
