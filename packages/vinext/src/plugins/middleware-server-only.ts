import type { Plugin } from "vite";
import { normalizePathSeparators } from "../utils/path.js";

/**
 * Allow `import 'server-only'` from neutral server targets (and any module
 * reachable from them) in the SSR environment.
 *
 * Background: middleware runs server-side, so importing `server-only` is
 * semantically correct. However, vinext bundles middleware into the SSR
 * environment (via `virtual:vinext-server-entry`), and @vitejs/plugin-rsc's
 * `rsc:validate-imports` plugin treats any non-RSC environment as a "client"
 * build, rejecting `server-only` imports with:
 *
 *   'server-only' cannot be imported in client build ('ssr' environment)
 *
 * Next.js solves this with webpack `issuerLayer` rules: middleware,
 * instrumentation, and Pages API routes sit in server-only or neutral layers
 * where `server-only` is aliased to a no-op while `client-only` still errors. See
 *   packages/next/src/build/webpack-config.ts ("Alias server-only and
 *   client-only to proper exports based on bundling layers")
 *
 * Vite has no per-layer aliasing within a single environment, so we mirror
 * the behavior with import-chain taint tracking:
 *
 *   1. Seed a `tainted` set with the middleware entry path (and its
 *      canonical realpath), and recognize other neutral server entry modules
 *      such as Pages API routes through `isNeutralServerModule`.
 *   2. For every resolveId call from a tainted importer, resolve the import
 *      via `this.resolve(..., { skipSelf: true })` and add the resolved id
 *      to the tainted set. This propagates the taint along the import graph
 *      synchronously, before plugin-rsc's `order: "pre"` validate-imports
 *      handler sees the next `server-only` request.
 *   3. When a tainted module imports `server-only` in a non-RSC environment,
 *      short-circuit to the no-op shim path so plugin-rsc's filter (which
 *      matches the bare `^server-only$` specifier) never fires for that
 *      import.
 *
 * The taint set is scoped to the middleware chain only — `server-only`
 * imports from anywhere else (including client component code traversing
 * through the SSR environment for `react-dom/server.edge` rendering) still
 * hit the rsc:validate-imports rejection, preserving the original safety
 * net for accidental client-side `server-only` leakage.
 *
 * Ported from Next.js handling of `WEBPACK_LAYERS.middleware` /
 * `WEBPACK_LAYERS.GROUP.neutralTarget`:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/build/webpack-config.ts
 */
export function createMiddlewareServerOnlyPlugin(options: {
  getMiddlewarePath: () => string | null;
  getCanonicalMiddlewarePath: () => string | null;
  isNeutralServerModule?: (id: string) => boolean;
  serverOnlyShimPath: string;
}): Plugin {
  // Tracks module IDs reachable from the middleware entry. The set is
  // populated lazily as resolveId fires with tainted importers — we cannot
  // pre-walk the graph because middleware's imports aren't known until
  // Rolldown starts processing the entry.
  //
  // Rolldown canonicalizes IDs via fs.realpathSync.native, so we store
  // both the original and canonical paths when known. Comparisons are
  // done by checking the importer string verbatim (which is whatever
  // Rolldown handed us).
  const tainted = new Set<string>();

  // Canonicalize an id into the space the taint set lives in: forward slashes
  // (Rolldown ids are POSIX-normalized) with the query suffix stripped. The
  // seed paths come from `path.join`, which is backslash on Windows, so they
  // must be normalized to match the importer ids Rolldown passes in.
  function canonicalizeId(id: string): string {
    const queryIndex = id.indexOf("?");
    // Strip query string suffix (e.g. ?v=hash, ?rsc, ?used). Rolldown stores
    // module IDs with the query in `importer` strings for HMR / dep optimizer
    // round-trips; the canonical id we tracked doesn't carry one.
    return normalizePathSeparators(queryIndex === -1 ? id : id.slice(0, queryIndex));
  }

  function isTainted(id: string | undefined): boolean {
    if (!id) return false;
    return tainted.has(canonicalizeId(id));
  }

  function addTainted(id: string): void {
    tainted.add(canonicalizeId(id));
  }

  return {
    name: "vinext:middleware-server-only",
    // `enforce: "pre"` so this plugin's resolveId hook fires before
    // @vitejs/plugin-rsc's `rsc:validate-imports` (which is a normal-priority
    // plugin with an `order: "pre"` hook). Vite groups by enforce first,
    // then by hook order — pre-enforce hooks always beat normal-enforce ones
    // regardless of hook-level order.
    enforce: "pre",

    buildStart() {
      // Reseed at the start of every build so consecutive `vite build`
      // invocations on the same plugin instance (used by the test suite)
      // don't carry over stale taint from a previous run.
      tainted.clear();
      const middlewarePath = options.getMiddlewarePath();
      if (middlewarePath) addTainted(middlewarePath);
      const canonical = options.getCanonicalMiddlewarePath();
      if (canonical) addTainted(canonical);
    },

    resolveId: {
      // No filter on the id — we need to observe every resolution whose
      // importer is tainted in order to propagate taint along the graph.
      // The hot path (importer not tainted, id !== "server-only") falls
      // through to `return undefined` immediately.
      order: "pre",
      async handler(id, importer, opts) {
        // Only relevant outside the RSC environment. Inside `rsc`, the
        // react-server export condition already makes `server-only` a no-op,
        // and plugin-rsc's validator allows it there.
        if (this.environment?.name === "rsc") return;
        if (!importer) return;
        if (!isTainted(importer) && !options.isNeutralServerModule?.(canonicalizeId(importer))) {
          return;
        }

        // server-only from a tainted importer → swap in the no-op shim
        // path before plugin-rsc's pre-resolveId can claim it as the
        // bare specifier.
        if (id === "server-only") {
          return { id: options.serverOnlyShimPath, moduleSideEffects: false };
        }

        // Propagate taint: resolve the import ourselves (skipSelf so we
        // don't recurse) and add the resolved id to the tainted set. We
        // don't return the resolved id — letting other plugins handle the
        // actual resolution keeps this plugin a pure tracker for any
        // import that isn't `server-only`.
        const resolved = await this.resolve(id, importer, { ...opts, skipSelf: true });
        if (resolved && !resolved.external) {
          addTainted(resolved.id);
        }
        return;
      },
    },
  };
}
