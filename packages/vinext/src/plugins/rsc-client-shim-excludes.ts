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
