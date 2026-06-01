import { describe, expect, it } from "vite-plus/test";
import {
  encodePrerenderRouteParams,
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

describe("encodePrerenderRouteParams", () => {
  it("round-trips fallbackParamNames when provided", () => {
    const payload = encodePrerenderRouteParams("/product/:id", { id: "abc" }, ["id"]);

    expect(payload).toEqual({
      routePattern: "/product/:id",
      params: { id: "abc" },
      fallbackParamNames: ["id"],
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
});
