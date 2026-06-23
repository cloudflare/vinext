import { describe, expect, it } from "vite-plus/test";
import {
  encodePrerenderRouteParams,
  matchPrerenderRouteParamsPayload,
  prerenderRouteParamsPayloadMatchesRoute,
  type PrerenderRouteParamsPayload,
} from "../packages/vinext/src/server/prerender-route-params.js";

describe("prerenderRouteParamsPayloadMatchesRoute", () => {
  it("requires the decoded prerender params to match the final route params", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/product/:id",
      params: { id: "sticks%20%26%20stones" },
    };

    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/product/:id", {
        id: "sticks & stones",
      }),
    ).toBe(true);
    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/product/:id", {
        id: "sticks-and-stones",
      }),
    ).toBe(false);
    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/source/:slug", {
        id: "sticks & stones",
      }),
    ).toBe(false);
  });

  it("compares catch-all params element-by-element after decoding", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/docs/:slug+",
      params: { slug: ["sticks%20%26%20stones", "more%20words"] },
    };

    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/docs/:slug+", {
        slug: ["sticks & stones", "more words"],
      }),
    ).toBe(true);
    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/docs/:slug+", {
        slug: ["more words", "sticks & stones"],
      }),
    ).toBe(false);
    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/docs/:slug+", {
        slug: "sticks & stones",
      }),
    ).toBe(false);
  });

  it("rejects a payload whose fallbackParamNames contain a param not present in the route pattern", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/product/:id",
      params: { id: "abc" },
      fallbackParamNames: ["id", "slug"],
    };

    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/product/:id", {
        id: "abc",
      }),
    ).toBe(false);
  });

  it("rejects a payload whose fallbackParamNames contain duplicates", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/product/:id",
      params: { id: "abc" },
      fallbackParamNames: ["id", "id"],
    };

    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/product/:id", {
        id: "abc",
      }),
    ).toBe(false);
  });

  it("returns false for a valid fallback-shell match because only exact matches are accepted", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/product/:id",
      params: { id: "abc" },
      fallbackParamNames: ["id"],
    };

    expect(
      prerenderRouteParamsPayloadMatchesRoute(payload, "/product/:id", {
        id: "abc",
      }),
    ).toBe(false);
  });
});

describe("matchPrerenderRouteParamsPayload", () => {
  it("returns kind exact when payload has no fallbackParamNames", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "hello%20world" },
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "hello world",
      }),
    ).toEqual({ kind: "exact", params: { locale: "en", slug: "hello%20world" } });
  });

  it("returns kind fallback-shell when payload has fallbackParamNames", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
      fallbackParamNames: ["slug"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "[slug]",
      }),
    ).toEqual({
      fallbackParamNames: ["slug"],
      kind: "fallback-shell",
      params: { locale: "en", slug: "%5Bslug%5D" },
    });
  });

  it("rejects fallback-shell payloads that name params outside the route pattern", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
      fallbackParamNames: ["missing"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "[slug]",
      }),
    ).toBeNull();
  });

  it("matches fallback-shell catch-all placeholders as route param arrays", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/docs/:slug+",
      params: { locale: "fr", slug: ["%5B...slug%5D"] },
      fallbackParamNames: ["slug"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/docs/:slug+", {
        locale: "fr",
        slug: ["[...slug]"],
      }),
    ).toEqual({
      fallbackParamNames: ["slug"],
      kind: "fallback-shell",
      params: { locale: "fr", slug: ["%5B...slug%5D"] },
    });
  });
});

describe("encodePrerenderRouteParams", () => {
  it("encodes exact params without fallbackParamNames", () => {
    const result = encodePrerenderRouteParams("/product/:id", { id: "abc" });

    expect(result).toEqual({
      routePattern: "/product/:id",
      params: { id: "abc" },
    });
  });

  it("encodes fallback-shell params with fallbackParamNames", () => {
    const result = encodePrerenderRouteParams(
      "/:locale/blog/:slug",
      { locale: "en", slug: "[slug]" },
      ["slug"],
    );

    expect(result).toEqual({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
    });
  });

  it("omits fallbackParamNames when the array is empty", () => {
    const payload = encodePrerenderRouteParams("/product/:id", { id: "abc" }, []);

    expect(payload).toEqual({
      routePattern: "/product/:id",
      params: { id: "abc" },
    });
  });

  it("returns null when there are no dynamic params", () => {
    expect(encodePrerenderRouteParams("/about", {})).toBe(null);
  });

  it("returns null when there are no dynamic params even with fallbackParamNames", () => {
    expect(encodePrerenderRouteParams("/about", {}, ["id"])).toBe(null);
  });

  it("percent-encodes param values", () => {
    const result = encodePrerenderRouteParams("/:locale/blog/:slug", {
      locale: "en",
      slug: "hello world & more",
    });

    expect(result).toEqual({
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "hello%20world%20%26%20more" },
    });
  });
});

describe("matchPrerenderRouteParamsPayload", () => {
  it("returns kind exact when payload has no fallbackParamNames", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "hello%20world" },
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "hello world",
      }),
    ).toEqual({ kind: "exact", params: { locale: "en", slug: "hello%20world" } });
  });

  it("returns kind fallback-shell when payload has fallbackParamNames", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
      fallbackParamNames: ["slug"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "[slug]",
      }),
    ).toEqual({
      fallbackParamNames: ["slug"],
      kind: "fallback-shell",
      params: { locale: "en", slug: "%5Bslug%5D" },
    });
  });

  it("rejects fallback-shell payloads that name params outside the route pattern", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
      fallbackParamNames: ["missing"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/blog/:slug", {
        locale: "en",
        slug: "[slug]",
      }),
    ).toBeNull();
  });

  it("matches fallback-shell catch-all placeholders as route param arrays", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/:locale/docs/:slug+",
      params: { locale: "fr", slug: ["%5B...slug%5D"] },
      fallbackParamNames: ["slug"],
    };

    expect(
      matchPrerenderRouteParamsPayload(payload, "/:locale/docs/:slug+", {
        locale: "fr",
        slug: ["[...slug]"],
      }),
    ).toEqual({
      fallbackParamNames: ["slug"],
      kind: "fallback-shell",
      params: { locale: "fr", slug: ["%5B...slug%5D"] },
    });
  });
});

describe("encodePrerenderRouteParams", () => {
  it("encodes exact params without fallbackParamNames", () => {
    const result = encodePrerenderRouteParams("/product/:id", { id: "abc" });
    expect(result).toEqual({
      routePattern: "/product/:id",
      params: { id: "abc" },
    });
  });

  it("encodes fallback-shell params with fallbackParamNames", () => {
    const result = encodePrerenderRouteParams(
      "/:locale/blog/:slug",
      { locale: "en", slug: "[slug]" },
      ["slug"],
    );
    expect(result).toEqual({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "%5Bslug%5D" },
    });
  });

  it("returns null for static patterns with no dynamic params", () => {
    expect(encodePrerenderRouteParams("/about", {})).toBeNull();
  });

  it("percent-encodes param values", () => {
    const result = encodePrerenderRouteParams("/:locale/blog/:slug", {
      locale: "en",
      slug: "hello world & more",
    });
    expect(result).toEqual({
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "hello%20world%20%26%20more" },
    });
  });

  it("omits fallbackParamNames when empty array is passed", () => {
    const result = encodePrerenderRouteParams(
      "/:locale/blog/:slug",
      { locale: "en", slug: "post" },
      [],
    );
    expect(result).toEqual({
      routePattern: "/:locale/blog/:slug",
      params: { locale: "en", slug: "post" },
    });
  });
});
