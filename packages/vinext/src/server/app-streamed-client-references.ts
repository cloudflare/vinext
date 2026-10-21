/**
 * Stream the client references an SSR render may show before they load.
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
 */
import * as ReactDOM from "react-dom";
import { setOnClientReference } from "@vitejs/plugin-rsc/ssr";
import { getOrCreateAls } from "vinext/shims/internal/als-registry";
import type { RouteClientReferenceSet } from "./app-client-reference-preloader.js";
import { escapeHtmlAttr } from "./html.js";

type AssetDeps = { js: string[]; css: string[] };
type ClientReferenceRequire = (id: string) => Promise<unknown>;
type ClientReferenceLoader = () => Promise<unknown>;

/** A render's streamed references, and the stylesheets the render linked. */
export type StreamedClientReferences = {
  streamed: ReadonlySet<string>;
  /** Each of the route's references' position in import order. */
  positions: ReadonlyMap<string, number>;
  /** Streamed references whose stylesheets aren't linked yet, in import order. */
  unlinked: string[];
  linkedStylesheets: Set<string>;
};

const WRAPPED = Symbol.for("vinext.streamedClientReferences.wrapped");
// Mirrors plugin-rsc's preloadDeps().
const STYLESHEET_PRECEDENCE = "vite-rsc/client-reference";

// Each reference's assets from plugin-rsc's assets manifest, reported as its
// load starts.
const referenceDeps = new Map<string, AssetDeps>();
const renderStorage = getOrCreateAls<StreamedClientReferences>("vinext.streamedClientReferences");

// Mirrors plugin-rsc's preloadDeps(), which leaves the client entry's own
// scripts at the default priority; the render has preinitialized those already.
function linkScripts(deps: AssetDeps): void {
  // React copies every option onto the link; its types leave out fetchPriority.
  const options = {
    as: "script",
    crossOrigin: "",
    fetchPriority: "low",
  } as ReactDOM.PreloadModuleOptions;
  for (const href of deps.js) ReactDOM.preloadModule(href, options);
}

/**
 * Before reference `id` links its stylesheets, link those of the streamed
 * references that come before it in import order.
 */
function linkStreamedStylesheetsBefore(render: StreamedClientReferences, id: string): void {
  const position = render.positions.get(id);
  if (position === undefined) return;
  while (render.unlinked.length > 0 && render.positions.get(render.unlinked[0]!)! < position) {
    for (const href of referenceDeps.get(render.unlinked.shift()!)?.css ?? []) {
      render.linkedStylesheets.add(href);
      ReactDOM.preinit(href, {
        as: "style",
        crossOrigin: "anonymous",
        precedence: STYLESHEET_PRECEDENCE,
      });
    }
  }
}

/**
 * Wrap plugin-rsc's client-reference loader before any client reference
 * loads; a build with references to stream calls this as its SSR entry starts.
 * `asyncIds` are the references any route may stream, and `getLoader` returns
 * a reference's own loader from the client-references module.
 */
export function wrapClientReferenceRequireForStreaming(
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
  // module's load state on.
  const loads = new Map<string, Promise<unknown>>();
  const wrapped: ClientReferenceRequire = (id) => {
    // The Flight client asks for a module as it reads the row naming it.
    const render = renderStorage.getStore();
    if (render?.streamed.has(id)) {
      const deps = referenceDeps.get(id);
      if (deps) linkScripts(deps);
    }
    let loading = loads.get(id);
    if (!loading) {
      const loader = asyncIds.has(id) ? getLoader(id) : undefined;
      loading = Promise.all([load(id), loader?.()]).then(
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
): StreamedClientReferences | null {
  if (!route || route.streamed.length === 0) return null;
  const streamed = new Set(route.streamed);
  return {
    streamed,
    positions: new Map(route.references.map((id, index) => [id, index])),
    unlinked: route.references.filter((id) => streamed.has(id)),
    linkedStylesheets: new Set(),
  };
}

/** Run a render, and the Flight stream it reads, with its streamed references. */
export function runWithStreamedClientReferences<R>(
  render: StreamedClientReferences | null,
  fn: () => R,
): R {
  return render ? renderStorage.run(render, fn) : fn();
}

/**
 * The `<head>` links of the streamed stylesheets a render's shell left
 * unlinked, those of streamed references after every reference it rendered.
 */
export function renderStreamedStylesheets(render: StreamedClientReferences | null): string {
  if (!render) return "";
  const hrefs = new Set<string>();
  for (const id of render.unlinked.splice(0)) {
    for (const href of referenceDeps.get(id)?.css ?? []) {
      if (!render.linkedStylesheets.has(href)) hrefs.add(href);
    }
  }
  let html = "";
  for (const href of hrefs) {
    render.linkedStylesheets.add(href);
    html += `<link rel="stylesheet" href="${escapeHtmlAttr(href)}" data-precedence="${STYLESHEET_PRECEDENCE}" crossorigin=""/>`;
  }
  return html;
}
