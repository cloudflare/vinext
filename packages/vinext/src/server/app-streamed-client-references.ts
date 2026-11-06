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
 * React only preloads a stylesheet linked after the shell, and reveals its
 * boundary without waiting for it. So a render still going at its first flush
 * links its route's static references' stylesheets there, as Next.js renders
 * them beside each route file. After the shell's, to keep the cascade.
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
import * as ReactDOM from "react-dom";
import { setOnClientReference } from "@vitejs/plugin-rsc/ssr";
import { getOrCreateAls } from "vinext/shims/internal/als-registry";
import type { RouteClientReferenceSet } from "./app-client-reference-preloader.js";
import { escapeHtmlAttr } from "./html.js";
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
  /** Each of the route's references' position in import order. */
  positions: ReadonlyMap<string, number>;
  /** Streamed references whose stylesheets aren't linked yet, in import order. */
  unlinked: string[];
  /** References to link if the render is still going at its first flush. */
  rendered: readonly string[];
  /** Stylesheets in `<head>` once the first flush starts. */
  headStylesheets: Set<string>;
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
 * Before reference `id` links its stylesheets, link those of the streamed
 * references that come before it in import order.
 */
function linkStreamedStylesheetsBefore(render: StreamedClientReferences, id: string): void {
  const position = render.positions.get(id);
  if (position === undefined) return;
  while (render.unlinked.length > 0 && render.positions.get(render.unlinked[0]!)! < position) {
    linkStylesheets(referenceDeps.get(render.unlinked.shift()!)?.css ?? [], render);
  }
}

/**
 * Wrap plugin-rsc's client-reference loader before any client reference
 * loads; a production build calls this as its SSR entry starts. `getLoader`
 * returns a reference's own loader from the client-references module.
 */
export function wrapClientReferenceRequire(
  getLoader: (id: string) => ClientReferenceLoader | undefined,
): void {
  const load: ClientReferenceRequire | undefined = globalThis.__vite_rsc_client_require__;
  if (typeof load !== "function" || WRAPPED in load) return;
  setOnClientReference(({ id, deps }) => {
    referenceDeps.set(id, deps);
  });
  // One promise per reference, which React's Flight client tracks the
  // module's load state on.
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
      loading = Promise.all([load(id), getLoader(id)?.()]).then(
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
                const deps = referenceDeps.get(id);
                // Likewise one already in `<head>`, which React would preload.
                if (
                  exports !== undefined &&
                  deps?.css.length &&
                  deps.css.every((href) => render.headStylesheets.has(href))
                ) {
                  if (key in target) linkScripts(deps, render);
                  return Reflect.get(exports as object, key);
                }
                linkStreamedStylesheetsBefore(render, id);
                // plugin-rsc links the module's assets as it's read, after this.
                if (deps && key in target) {
                  linkStylesheets(deps.css, render);
                  if (hintsScripts(render)) linkScripts(deps, render);
                }
              }
              return Reflect.get(target, key, receiver);
            },
          }),
      );
      loads.set(id, loading);
    }
    return loading;
  };
  Object.defineProperty(wrapped, WRAPPED, { value: true });
  globalThis.__vite_rsc_client_require__ = wrapped;
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
    positions: new Map(route?.references.map((id, index) => [id, index])),
    unlinked: route?.references.filter((id) => streamed.has(id)) ?? [],
    rendered: route?.stylesheets ?? [],
    headStylesheets: new Set(),
  };
}

/**
 * Forget the stylesheets a discarded render linked, so the render that
 * replaces it links them again.
 */
export function resetStreamedClientReferences(
  render: StreamedClientReferences | null,
  route: RouteClientReferenceSet | undefined,
): void {
  if (!render) return;
  render.unlinked = route?.references.filter((id) => render.streamed.has(id)) ?? [];
}

/** Run a render, and the Flight stream it reads, with its streamed references. */
export function runWithStreamedClientReferences<R>(
  render: StreamedClientReferences,
  fn: () => R,
): R {
  return renderStorage.run(render, fn);
}

/**
 * The stylesheets `<head>` must hold, in import order: streamed references' and,
 * while `stillRendering`, `rendered`'s. Call this as React's first flush starts.
 */
export function takeStreamedStylesheets(
  render: StreamedClientReferences,
  stillRendering: boolean,
): readonly string[] {
  const ids = new Set(render.unlinked.splice(0));
  if (stillRendering) for (const id of render.rendered) ids.add(id);
  for (const id of [...ids].sort((a, b) => render.positions.get(a)! - render.positions.get(b)!)) {
    for (const href of referenceDeps.get(id)?.css ?? []) render.headStylesheets.add(href);
  }
  return [...render.headStylesheets];
}

/**
 * The links of `hrefs` that React's `<head>` left out. Those it wrote keep their
 * place, as a second copy after them would override the stylesheets between.
 */
export function renderStreamedStylesheets(
  render: StreamedClientReferences,
  hrefs: readonly string[],
  headHrefs: ReadonlySet<string>,
): string {
  // React writes "" for anonymous.
  const crossOrigin = render.crossOrigin === "use-credentials" ? "use-credentials" : "";
  let html = "";
  for (const href of hrefs) {
    const attr = escapeHtmlAttr(href);
    if (headHrefs.has(attr)) continue;
    html += `<link rel="stylesheet" href="${attr}" data-precedence="${STYLESHEET_PRECEDENCE}" crossorigin="${crossOrigin}"/>`;
  }
  return html;
}
