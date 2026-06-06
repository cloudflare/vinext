import { describe, expect, it, vi } from "vitest";
import { createAppPrerenderStaticParamsResolver } from "../packages/vinext/src/server/app-prerender-static-params.js";

describe("createAppPrerenderStaticParamsResolver", () => {
  it("returns null when there are no sources at all", () => {
    expect(createAppPrerenderStaticParamsResolver([])).toBeNull();
    // An eager source that is not a function (e.g. `mod?.generateStaticParams`
    // where the module has none) and no lazy sources → still null.
    expect(createAppPrerenderStaticParamsResolver([undefined])).toBeNull();
  });

  it("resolves an eager generateStaticParams source", async () => {
    const fn = () => [{ id: "a" }, { id: "b" }];
    const resolver = createAppPrerenderStaticParamsResolver([fn]);
    expect(resolver).not.toBeNull();
    await expect(resolver!({ params: {} })).resolves.toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("loads a lazy page source on demand and reads its generateStaticParams", async () => {
    const load = vi.fn(async () => ({
      generateStaticParams: () => [{ slug: "x" }, { slug: "y" }],
    }));
    const resolver = createAppPrerenderStaticParamsResolver([{ load }]);
    expect(resolver).not.toBeNull();
    // Not loaded until the resolver is actually invoked (prerender time).
    expect(load).not.toHaveBeenCalled();

    await expect(resolver!({ params: {} })).resolves.toEqual([{ slug: "x" }, { slug: "y" }]);
    expect(load).toHaveBeenCalledTimes(1);

    // Memoized: a second call does not re-import.
    await resolver!({ params: {} });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("returns the null sentinel when a lazy page has no generateStaticParams", async () => {
    // A lazy page module with no generateStaticParams export. The resolver is
    // non-null (there is a source) but must yield null so the prerender driver
    // treats the route as having no static params (skip / output:export error).
    const resolver = createAppPrerenderStaticParamsResolver([
      { load: async () => ({ default: () => null }) },
    ]);
    expect(resolver).not.toBeNull();
    await expect(resolver!({ params: {} })).resolves.toBeNull();
  });

  it("composes an eager layout source with a lazy page source", async () => {
    const layout = () => [{ lang: "en" }, { lang: "fr" }];
    const load = async () => ({ generateStaticParams: () => [{ slug: "post" }] });
    const resolver = createAppPrerenderStaticParamsResolver([layout, { load }]);

    await expect(resolver!({ params: {} })).resolves.toEqual([
      { lang: "en", slug: "post" },
      { lang: "fr", slug: "post" },
    ]);
  });

  it("composes sources in declared order regardless of eager/lazy kind", async () => {
    // Lazy source first, eager second: composition order must follow `sources`
    // order, not be reordered to eager-then-lazy.
    const resolver = createAppPrerenderStaticParamsResolver([
      { load: async () => ({ generateStaticParams: () => [{ a: "1" }, { a: "2" }] }) },
      () => [{ b: "x" }],
    ]);

    await expect(resolver!({ params: {} })).resolves.toEqual([
      { a: "1", b: "x" },
      { a: "2", b: "x" },
    ]);
  });
});
