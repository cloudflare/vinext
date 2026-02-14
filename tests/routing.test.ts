import { describe, it, expect } from "vitest";
import path from "node:path";
import { pagesRouter, matchRoute } from "../packages/vite-plugin-nextcompat/src/routing/pages-router.js";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/pages-basic/pages",
);

describe("pagesRouter - route discovery", () => {
  it("discovers pages from the fixture directory", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    expect(routes.length).toBeGreaterThan(0);

    const patterns = routes.map((r) => r.pattern);
    expect(patterns).toContain("/");
    expect(patterns).toContain("/about");
    expect(patterns).toContain("/ssr");
  });

  it("discovers dynamic routes", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const dynamicRoute = routes.find((r) => r.pattern.includes(":id"));
    expect(dynamicRoute).toBeDefined();
    expect(dynamicRoute!.pattern).toBe("/posts/:id");
    expect(dynamicRoute!.isDynamic).toBe(true);
    expect(dynamicRoute!.params).toEqual(["id"]);
  });

  it("sorts static routes before dynamic routes", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const staticRoutes = routes.filter((r) => !r.isDynamic);
    const dynamicRoutes = routes.filter((r) => r.isDynamic);

    // All static routes should come before dynamic routes
    const lastStaticIndex = routes.findIndex(
      (r) => r === staticRoutes[staticRoutes.length - 1],
    );
    const firstDynamicIndex = routes.findIndex(
      (r) => r === dynamicRoutes[0],
    );

    if (staticRoutes.length > 0 && dynamicRoutes.length > 0) {
      expect(lastStaticIndex).toBeLessThan(firstDynamicIndex);
    }
  });

  it("ignores _app.tsx and _document.tsx", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    expect(patterns).not.toContain("/_app");
    expect(patterns).not.toContain("/_document");
    expect(patterns).not.toContain("/_error");
  });
});

describe("matchRoute - URL matching", () => {
  it("matches static routes", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/");

    const aboutResult = matchRoute("/about", routes);
    expect(aboutResult).not.toBeNull();
    expect(aboutResult!.route.pattern).toBe("/about");
  });

  it("matches dynamic routes and extracts params", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/posts/42", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/posts/:id");
    expect(result!.params).toEqual({ id: "42" });
  });

  it("returns null for unmatched routes", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/nonexistent", routes);
    expect(result).toBeNull();
  });

  it("strips query strings before matching", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/?foo=bar", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/");
  });

  it("strips trailing slashes before matching", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/about/", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/about");
  });

  it("discovers catch-all routes [...slug]", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const catchAll = routes.find((r) => r.pattern.includes(":slug+"));
    expect(catchAll).toBeTruthy();
    expect(catchAll!.pattern).toBe("/docs/:slug+");
    expect(catchAll!.isDynamic).toBe(true);
    expect(catchAll!.params).toContain("slug");
  });

  it("matches catch-all routes with multiple segments", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/docs/getting-started/install", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/docs/:slug+");
    expect(result!.params.slug).toEqual(["getting-started", "install"]);
  });

  it("matches catch-all routes with single segment", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/docs/intro", routes);
    expect(result).not.toBeNull();
    expect(result!.params.slug).toEqual(["intro"]);
  });

  it("does not match catch-all with zero segments", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    // /docs alone should NOT match [...slug] (requires at least 1 segment)
    const result = matchRoute("/docs", routes);
    expect(result).toBeNull();
  });
});
