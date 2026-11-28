import { describe, expect, it, vi } from "vite-plus/test";
import { createAppPrerenderStaticParamsResolver } from "../packages/vinext/src/server/app-prerender-static-params.js";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";
import { getRootParam } from "../packages/vinext/src/shims/root-params.js";

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

  it("keeps the request that starts lazy source resolution alive until it settles", async () => {
    // The resolution is memoized for the isolate, and workerd drops a canceled
    // request's pending I/O, so a timed-out discovery request must not strand it.
    let release: () => void = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolver = createAppPrerenderStaticParamsResolver([
      {
        load: async () => {
          await loaded;
          return { generateStaticParams: () => [{ slug: "x" }] };
        },
      },
    ]);
    const creator = { waitUntil: vi.fn() };
    const joiner = { waitUntil: vi.fn() };

    const first = runWithExecutionContext(creator, () => resolver!({ params: {} }));
    const second = runWithExecutionContext(joiner, () => resolver!({ params: {} }));

    expect(creator.waitUntil).toHaveBeenCalledOnce();
    expect(joiner.waitUntil).not.toHaveBeenCalled();
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([[{ slug: "x" }], [{ slug: "x" }]]);
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

  // Next.js rejects malformed output in every mode, not only during CDN warm
  // path discovery (build/static-paths/app.ts callGenerateStaticParams).
  it("surfaces malformed results", async () => {
    const nonArray = createAppPrerenderStaticParamsResolver([() => null]);
    await expect(nonArray!({ params: {} })).rejects.toThrow(
      "generateStaticParams must return an array",
    );

    const nonObjectEntry = createAppPrerenderStaticParamsResolver([() => ["slug"]]);
    await expect(nonObjectEntry!({ params: {} })).rejects.toThrow(
      "generateStaticParams must return an array of objects",
    );

    const nonPlainEntry = createAppPrerenderStaticParamsResolver([() => [new Date(0)]]);
    await expect(nonPlainEntry!({ params: {} })).rejects.toThrow(
      "generateStaticParams must return an array of objects",
    );
  });
});

// Ported from Next.js server/request/root-params.ts (the `generate-static-params`
// work unit) and build/static-paths/app.ts `callGenerateStaticParams`: a
// generator sees only the root params its parent generators provided, and
// reading another one fails the build. Mirrors the deploy-suite fixture
// app-root-params-getters/generate-static-params-error, whose [lang]/[locale]
// layout calls lang() inside its own generateStaticParams.
describe("createAppPrerenderStaticParamsResolver root params", () => {
  const unprovidedLang =
    "Route /[lang]/[locale] used `import('next/root-params').lang()` inside `generateStaticParams`, but the `lang` parameter was not provided by a parent `generateStaticParams`.";

  it("rejects when the first of several generators reads a root param no parent provided", async () => {
    const langLocaleLayout = async () => {
      await getRootParam("lang");
      return [{ lang: "en", locale: "us" }];
    };
    const page = () => [];
    const resolver = createAppPrerenderStaticParamsResolver(
      [langLocaleLayout, page],
      ["lang", "locale"],
    );

    await expect(resolver!({ params: {}, route: "/:lang/:locale" })).rejects.toThrow(
      unprovidedLang,
    );
  });

  it("rejects when a single generator reads a root param no parent provided", async () => {
    const langLocaleLayout = async () => {
      await getRootParam("lang");
      return [{ lang: "en", locale: "us" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver([langLocaleLayout], ["lang", "locale"]);

    await expect(resolver!({ params: {}, route: "/:lang/:locale" })).rejects.toThrow(
      unprovidedLang,
    );
  });

  it("gives a nested generator the root params its parents provided", async () => {
    const seen: unknown[] = [];
    const langLayout = () => [{ lang: "en" }];
    const localeLayout = async () => {
      seen.push(await getRootParam("lang"));
      return [{ locale: "us" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver(
      [langLayout, localeLayout],
      ["lang", "locale"],
    );

    await expect(resolver!({ params: {}, route: "/:lang/:locale" })).resolves.toEqual([
      { lang: "en", locale: "us" },
    ]);
    expect(seen).toEqual(["en"]);
  });

  it("names the route being built, not the shared layout's prefix", async () => {
    const langLocaleLayout = async () => {
      await getRootParam("lang");
      return [{ lang: "en", locale: "us" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver([langLocaleLayout], ["lang", "locale"]);

    await expect(resolver!({ params: {}, route: "/:lang/:locale/other/:slug" })).rejects.toThrow(
      "Route /[lang]/[locale]/other/[slug] used `import('next/root-params').lang()` inside `generateStaticParams`",
    );
  });

  it("names an intercepting route in Next.js route syntax", async () => {
    const page = async () => {
      await getRootParam("lang");
      return [{ id: "1" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver([page], []);

    await expect(resolver!({ params: {}, route: "/feed/(.):id/:rest+/:opt*" })).rejects.toThrow(
      "Route /feed/(.)[id]/[...rest]/[[...opt]] used `import('next/root-params').lang()` inside `generateStaticParams`",
    );
  });

  it("treats a root param named like an Object.prototype member as provided", async () => {
    // Next.js checks `key in parentParams` and `paramName in rootParams` on
    // plain objects, so an inherited name such as `constructor` passes both
    // checks, even in the generator of the segment that provides it.
    const constructorLayout = async () => {
      await getRootParam("constructor");
      return [{ constructor: "a" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver([constructorLayout], ["constructor"]);

    await expect(resolver!({ params: {}, route: "/:constructor" })).resolves.toEqual([
      { constructor: "a" },
    ]);
  });

  it("rejects a root param getter on a route without root params", async () => {
    // `next/root-params` exports the getters of every root, so another
    // root's `lang()` can run here. Next.js's work unit then has no root
    // params at all.
    const page = async () => {
      await getRootParam("lang");
      return [{ slug: "post" }];
    };
    const resolver = createAppPrerenderStaticParamsResolver([page], []);

    await expect(resolver!({ params: {}, route: "/blog/:slug" })).rejects.toThrow(
      "Route /blog/[slug] used `import('next/root-params').lang()` inside `generateStaticParams`, but the `lang` parameter was not provided",
    );
  });
});
