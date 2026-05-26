import { describe, expect, it } from "vite-plus/test";
import {
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
});
