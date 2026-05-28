import { createElement } from "react";
import { describe, expect, it } from "vite-plus/test";
import { computeAppRouteStaticSiblings } from "../packages/vinext/src/routing/app-router.js";
import { APP_STATIC_SIBLINGS_KEY } from "../packages/vinext/src/server/app-elements.js";
import { buildAppPageElements } from "../packages/vinext/src/server/app-page-route-wiring.js";

// Ported from Next.js: test/e2e/app-dir/static-siblings/static-siblings.test.ts
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/static-siblings/static-siblings.test.ts
//
// Issue: https://github.com/cloudflare/vinext/issues/1525
describe("App Router static-sibling info on the server response", () => {
  describe("computeAppRouteStaticSiblings", () => {
    it("returns the names of static sibling routes at the dynamic URL level", () => {
      // Mirrors Next.js's filesystem layout used in the static-siblings e2e
      // fixture: cross-route-group siblings where the static page (`sale`) and
      // the dynamic page (`[id]`) live under different route groups but share
      // the URL prefix `/products`.
      const routes = [
        { patternParts: ["products", "sale"] }, // /products/sale
        { patternParts: ["products", ":id"] }, // /products/[id]
      ];
      expect(computeAppRouteStaticSiblings(routes, routes[1])).toEqual(["sale"]);
    });

    it("collects same-directory sibling segments alongside the dynamic segment", () => {
      // /items/featured + /items/[id]
      const routes = [{ patternParts: ["items", "featured"] }, { patternParts: ["items", ":id"] }];
      expect(computeAppRouteStaticSiblings(routes, routes[1])).toEqual(["featured"]);
    });

    it("only collects siblings at the same level — does not leak nested segments", () => {
      // /categories/electronics/computers/laptops + /categories/[slug] must
      // collect only `electronics` for [slug]. Nested `computers` and
      // `laptops` are below the sibling level and must not be reported.
      const routes = [
        { patternParts: ["categories", "electronics", "computers", "laptops"] },
        { patternParts: ["categories", ":slug"] },
      ];
      expect(computeAppRouteStaticSiblings(routes, routes[1])).toEqual(["electronics"]);
    });

    it("returns an empty list when no static siblings exist", () => {
      const routes = [{ patternParts: ["only", ":id"] }, { patternParts: ["unrelated", "page"] }];
      expect(computeAppRouteStaticSiblings(routes, routes[0])).toEqual([]);
    });

    it("returns an empty list for fully-static routes", () => {
      const routes = [{ patternParts: ["a", "b"] }, { patternParts: ["a", "c"] }];
      expect(computeAppRouteStaticSiblings(routes, routes[0])).toEqual([]);
    });

    it("deduplicates sibling names that appear in multiple routes", () => {
      const routes = [
        { patternParts: ["x", "sale"] },
        { patternParts: ["x", "sale", "deeper"] },
        { patternParts: ["x", ":id"] },
      ];
      expect(computeAppRouteStaticSiblings(routes, routes[2])).toEqual(["sale"]);
    });
  });

  describe("buildAppPageElements", () => {
    it("emits __staticSiblings in the elements payload when the route has static siblings", () => {
      // The static-siblings e2e test asserts that the substring `"sale"` is
      // present in the RSC payload for a dynamic route that has `sale` as a
      // static sibling. The wire serializer spreads element keys directly into
      // the Flight payload, so emitting an `__staticSiblings: ["sale"]` entry
      // here is sufficient for the substring to land on the wire.
      function PageProbe() {
        return createElement("main", null, "Page");
      }
      function RootLayout(props: Record<string, unknown>) {
        return createElement("div", null, props.children as never);
      }

      const elements = buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: { id: "123" },
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null, null],
          layoutTreePositions: [0, 1],
          layouts: [{ default: RootLayout }, null],
          loading: null,
          notFound: null,
          notFounds: [null, null],
          routeSegments: ["products", "[id]"],
          slots: {},
          staticSiblings: ["sale"],
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/products/123",
        rootNotFoundModule: null,
      });

      expect(elements[APP_STATIC_SIBLINGS_KEY]).toEqual(["sale"]);
    });

    it("omits __staticSiblings when the route has no siblings", () => {
      function PageProbe() {
        return createElement("main", null, "Page");
      }
      function RootLayout(props: Record<string, unknown>) {
        return createElement("div", null, props.children as never);
      }

      const elements = buildAppPageElements({
        element: createElement(PageProbe),
        makeThenableParams(params) {
          return Promise.resolve(params);
        },
        matchedParams: {},
        resolvedMetadata: null,
        resolvedViewport: {},
        route: {
          error: null,
          errors: [null],
          layoutTreePositions: [0],
          layouts: [{ default: RootLayout }],
          loading: null,
          notFound: null,
          notFounds: [null],
          routeSegments: ["about"],
          slots: {},
          staticSiblings: [],
          templateTreePositions: [],
          templates: [],
        },
        routePath: "/about",
        rootNotFoundModule: null,
      });

      expect(elements[APP_STATIC_SIBLINGS_KEY]).toBeUndefined();
    });
  });
});
