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

// The `browser` export condition must never be active when vinext resolves
// modules for server-side rendering. The RSC and SSR environments execute in
// Node.js or the Cloudflare Workers runtime — neither is a browser, and neither
// defines DOM globals like `HTMLElement`, `window`, or `customElements`.
//
// Isomorphic libraries use the `browser` condition (often via `esm-env`'s
// `BROWSER` flag, whose `./browser` export resolves to `true` only under the
// `browser` condition) to decide whether to touch the DOM at module-init time.
// A common pattern — used by `number-flow` / `@number-flow/react`, among others
// that register a custom element — is:
//
//     const Base = BROWSER ? HTMLElement : class {};
//     class MyElement extends Base {}   // evaluated at import time
//
// When the SSR/RSC bundle resolves such a library with the `browser` condition,
// `BROWSER` becomes `true` and `class extends HTMLElement` runs as soon as the
// module loads — crashing with `ReferenceError: HTMLElement is not defined` in
// Node and Workers.
//
// Plain Node SSR already resolves with server conditions (no `browser`), so the
// crash only appears on bundled runtimes whose plugins add `browser` to the
// worker environment's resolve conditions — most notably `@cloudflare/vite-plugin`,
// which sets `["workerd", "worker", "module", "browser", ...]` for every worker
// environment (including the rsc/ssr environments vinext renders through).
// Removing `browser` makes those environments resolve the same server-safe entry
// that `next build && next start` does. The client environment keeps `browser`,
// so the browser bundle is unaffected.
const BROWSER_RESOLVE_CONDITION = "browser";

/**
 * Return a copy of `conditions` with the `browser` export condition removed.
 * Returns the input unchanged when it is not an array (so callers can pass an
 * absent/undefined conditions list through without a guard).
 */
export function withoutBrowserCondition(
  conditions: readonly string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(conditions)) return conditions as string[] | undefined;
  return conditions.filter((condition) => condition !== BROWSER_RESOLVE_CONDITION);
}

/**
 * Minimal structural shape of a resolved Vite environment's resolution config.
 * Kept loose on purpose so this helper works across Vite's `esbuild`/`rolldown`
 * dep-optimizer variants without depending on version-specific types.
 */
type ServerEnvResolveConfig = {
  resolve?: { conditions?: string[] };
  optimizeDeps?: {
    rolldownOptions?: { resolve?: { conditionNames?: string[] } };
    esbuildOptions?: { conditions?: string[] };
  };
};

/**
 * Strip the `browser` export condition from a server environment's resolve
 * conditions and its dep-optimizer conditions, in place.
 *
 * No-op when `browser` is absent, so this is safe to call unconditionally on
 * plain-Node builds where the server environments never carry the `browser`
 * condition. Both the resolver conditions (used by production builds) and the
 * dep-optimizer conditions (used by dev/`wrangler dev`) are handled so the two
 * code paths stay in sync.
 */
export function stripBrowserConditionFromServerEnv(env: ServerEnvResolveConfig | undefined): void {
  if (!env) return;

  if (env.resolve?.conditions) {
    env.resolve.conditions = withoutBrowserCondition(env.resolve.conditions) ?? [];
  }

  const rolldownResolve = env.optimizeDeps?.rolldownOptions?.resolve;
  if (rolldownResolve?.conditionNames) {
    rolldownResolve.conditionNames = withoutBrowserCondition(rolldownResolve.conditionNames) ?? [];
  }

  const esbuildOptions = env.optimizeDeps?.esbuildOptions;
  if (esbuildOptions?.conditions) {
    esbuildOptions.conditions = withoutBrowserCondition(esbuildOptions.conditions) ?? [];
  }
}
