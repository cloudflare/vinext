import { describe, expect, it } from "vite-plus/test";
import {
  encodePrerenderRouteParams,
  isTrustedPrerenderState,
  matchPrerenderRouteParamsPayload,
  readTrustedPrerenderStateFromHeaders,
  type PrerenderRouteParamsPayload,
} from "../packages/vinext/src/server/prerender-route-params.js";

describe("trusted prerender stage state", () => {
  it("authenticates route params and speculative mode once at the request boundary", () => {
    const previousPrerender = process.env.VINEXT_PRERENDER;
    process.env.VINEXT_PRERENDER = "1";
    try {
      const headers = new Headers({
        "x-vinext-prerender-route-params": encodeURIComponent(
          JSON.stringify({ routePattern: "/post/:slug", params: { slug: "hello" } }),
        ),
        "x-vinext-prerender-secret": "expected-secret",
        "x-vinext-prerender-speculative": "1",
      });

      expect(readTrustedPrerenderStateFromHeaders(headers, "expected-secret")).toEqual({
        routeParams: { routePattern: "/post/:slug", params: { slug: "hello" } },
        speculative: true,
      });
      expect(readTrustedPrerenderStateFromHeaders(headers, "wrong-secret")).toBeNull();
    } finally {
      if (previousPrerender === undefined) delete process.env.VINEXT_PRERENDER;
      else process.env.VINEXT_PRERENDER = previousPrerender;
    }
  });

  it("validates the complete serialized stage shape", () => {
    const state = {
      routeParams: { routePattern: "/post/:slug", params: { slug: "hello" } },
      speculative: true,
    };
    expect(isTrustedPrerenderState(state)).toBe(true);
    expect(isTrustedPrerenderState({ ...state, secret: "must-not-cross" })).toBe(false);
    expect(isTrustedPrerenderState({ ...state, speculative: "1" })).toBe(false);
  });
});

function matchesExactRoute(
  payload: PrerenderRouteParamsPayload | null,
  routePattern: string,
  params: Record<string, string | string[]>,
): boolean {
  return matchPrerenderRouteParamsPayload(payload, routePattern, params)?.kind === "exact";
}

describe("matchPrerenderRouteParamsPayload exact matches", () => {
  it("requires the decoded prerender params to match the final route params", () => {
    const payload: PrerenderRouteParamsPayload = {
      routePattern: "/product/:id",
      params: { id: "sticks%20%26%20stones" },
    };

    expect(
      matchesExactRoute(payload, "/product/:id", {
        id: "sticks & stones",
      }),
    ).toBe(true);
    expect(
      matchesExactRoute(payload, "/product/:id", {
        id: "sticks%20%26%20stones",
      }),
    ).toBe(true);
    expect(
      matchesExactRoute(payload, "/product/:id", {
        id: "sticks-and-stones",
      }),
    ).toBe(false);
    expect(
      matchesExactRoute(payload, "/source/:slug", {
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
      matchesExactRoute(payload, "/docs/:slug+", {
        slug: ["sticks & stones", "more words"],
      }),
    ).toBe(true);
    expect(
      matchesExactRoute(payload, "/docs/:slug+", {
        slug: ["sticks%20%26%20stones", "more%20words"],
      }),
    ).toBe(true);
    expect(
      matchesExactRoute(payload, "/docs/:slug+", {
        slug: ["more words", "sticks & stones"],
      }),
    ).toBe(false);
    expect(
      matchesExactRoute(payload, "/docs/:slug+", {
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
      matchesExactRoute(payload, "/product/:id", {
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
      matchesExactRoute(payload, "/product/:id", {
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
      matchesExactRoute(payload, "/product/:id", {
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
