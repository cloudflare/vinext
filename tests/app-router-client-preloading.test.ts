import { describe, expect, it } from "vitest";

describe("Client reference preloading (Issue #256)", () => {
  it("preloading correctly warms the memoize cache", async () => {
    // Replicate the memoize + lazy-load pattern from @vitejs/plugin-rsc
    // to verify that preloading prevents the first-request 500.
    const loadCounts = new Map<string, number>();

    function memoize(f: (id: string) => Promise<Record<string, unknown>>) {
      const cache = new Map<string, Promise<Record<string, unknown>>>();
      return (id: string) => {
        const cached = cache.get(id);
        if (cached !== undefined) return cached;
        const result = f(id);
        cache.set(id, result);
        return result;
      };
    }

    // Simulate lazy client module loading (async import)
    const requireModule = memoize(async (id: string) => {
      loadCounts.set(id, (loadCounts.get(id) ?? 0) + 1);
      // Simulate async module load
      await new Promise((r) => setTimeout(r, 10));
      return { default: `component-${id}` };
    });

    const clientRefs = { "comp-a": true, "comp-b": true, "comp-c": true };

    // Without preloading: requireModule returns unresolved promises
    const beforePreload = requireModule("comp-a");
    // The promise is pending — this is what causes the 500 on first request
    expect(beforePreload).toBeInstanceOf(Promise);

    // Preload all references (the fix)
    await Promise.all(Object.keys(clientRefs).map((id) => requireModule(id)));

    // After preloading: memoize cache is warm, promises are resolved.
    // Calling requireModule again returns the same (now-resolved) promise.
    const afterPreload = requireModule("comp-a");
    expect(afterPreload).toBeInstanceOf(Promise);
    const resolved = await afterPreload;
    expect(resolved).toEqual({ default: "component-comp-a" });

    // Critical invariant: after preloading, the cached promise must be
    // already settled. React SSR calls __vite_rsc_client_require__ and
    // expects a synchronously resolvable value — if the promise is still
    // pending, renderToReadableStream rejects (the original 500 bug).
    const SETTLED = Symbol("settled");
    const raceResult = await Promise.race([requireModule("comp-b"), Promise.resolve(SETTLED)]);
    // If the cached promise were still pending, raceResult would be SETTLED.
    // A resolved cache means the module value wins the race.
    expect(raceResult).toEqual({ default: "component-comp-b" });

    // Each module should only be loaded once (memoize dedup)
    expect(loadCounts.get("comp-a")).toBe(1);
    expect(loadCounts.get("comp-b")).toBe(1);
    expect(loadCounts.get("comp-c")).toBe(1);
  });
});
// ── Auto-registration of @vitejs/plugin-rsc ─────────────────────────────────
