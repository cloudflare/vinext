const RSC_CLIENT_SHIM_OPTIMIZE_DEPS_EXCLUDE = Object.freeze([
  // @vitejs/plugin-rsc tracks package client references by the original
  // bare source. If Vite pre-bundles these known client shims, the generated
  // client-package proxy can lose the matching export metadata in dev.
  "vinext/shims/error-boundary",
  "vinext/shims/form",
  "vinext/shims/layout-segment-context",
  "vinext/shims/link",
  "vinext/shims/script",
  "vinext/shims/slot",
  "vinext/shims/offline",
]);

export const VINEXT_OPTIMIZE_DEPS_EXCLUDE = Object.freeze([
  "vinext",
  "@vercel/og",
  // Aliased to the user's instrumentation-client source file (or an empty
  // shim). Not a real npm dep, so pre-bundling it would break HMR and cause
  // a "new dependencies optimized" reload on the first request.
  "private-next-instrumentation-client",
  ...RSC_CLIENT_SHIM_OPTIMIZE_DEPS_EXCLUDE,
]);

// React entries that @vitejs/plugin-rsc adds to environments.ssr.optimizeDeps.include
// via crawlFrameworkPkgs. When the user sets ssr.external: true, the SSR env loads
// everything via Node's resolver (including React from /node_modules/react). If Vite
// also pre-bundles React into deps_ssr/, two distinct React module records coexist:
// react-dom-server.edge sets the dispatcher on its bundled React, but externalized
// callers (vinext's runtime, and 'use client' modules going through the SSR transform)
// see a different React → React.H is null → useContext / useSyncExternalStore crash.
// Adding these to optimizeDeps.exclude keeps deps_ssr/ React-free so the runtime and
// the renderer share a single Node-loaded React copy.
export const SSR_EXTERNAL_REACT_ENTRIES = Object.freeze([
  "react",
  "react-dom",
  "react-dom/server.edge",
  "react-dom/static.edge",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-server-dom-webpack/client.edge",
]);

export function mergeOptimizeDepsExclude(
  ...excludeGroups: readonly (readonly string[])[]
): string[] {
  const seen = new Set<string>();

  for (const group of excludeGroups) {
    for (const entry of group) {
      if (seen.has(entry)) continue;
      seen.add(entry);
    }
  }

  return [...seen];
}
