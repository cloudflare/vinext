/**
 * Memoizes a pure per-module transform across the repeated build passes
 * (scan client/server references + rsc/client/ssr builds), which feed the
 * same module source through the same transform up to five times.
 *
 * Entries are keyed by module id and replaced when the source changes, so dev
 * rebuilds retain at most one source version per id. `variant` distinguishes
 * results that also depend on an environment-derived input (e.g. the
 * typeof-window replacement); callers must pass a primitive or stable
 * reference. Cached values include `null` ("no transform applies") so the
 * negative case is not recomputed either.
 *
 * Only safe for transforms whose result depends solely on (id, source,
 * variant) — no filesystem or plugin-state reads inside `compute`.
 */
export function createTransformCache<V, R>(): (
  id: string,
  source: string,
  variant: V,
  compute: () => R,
) => R {
  // Results are boxed so a cached value of `null`/`undefined` is
  // distinguishable from a cache miss without a type assertion.
  const cache = new Map<string, { source: string; results: Map<V, { value: R }> }>();

  return (id, source, variant, compute) => {
    let entry = cache.get(id);
    if (entry?.source !== source) {
      entry = { source, results: new Map() };
      cache.set(id, entry);
    }
    const boxed = entry.results.get(variant);
    if (boxed) return boxed.value;
    const value = compute();
    entry.results.set(variant, { value });
    return value;
  };
}
