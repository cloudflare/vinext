import { describe, it, expect } from "vitest";
import path from "node:path";
import { pagesRouter, matchRoute } from "../packages/vinext/src/routing/pages-router.js";
import { appRouter, matchAppRoute, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/pages-basic/pages",
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

    const dynamicRoute = routes.find((r) => r.pattern === "/posts/:id");
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

// ---------------------------------------------------------------
// App Router routing tests
// ---------------------------------------------------------------

const APP_FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "./fixtures/app-basic/app",
);

describe("appRouter - route discovery", () => {
  it("discovers page routes from the app directory", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    const pagePatterns = routes.filter((r) => r.pagePath).map((r) => r.pattern);

    expect(pagePatterns).toContain("/");
    expect(pagePatterns).toContain("/about");
    expect(pagePatterns).toContain("/blog/:slug");
  });

  it("discovers route handler (API) routes", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    const apiRoutes = routes.filter((r) => r.routePath);

    expect(apiRoutes.length).toBeGreaterThan(0);
    const apiPatterns = apiRoutes.map((r) => r.pattern);
    expect(apiPatterns).toContain("/api/hello");
  });

  it("discovers layouts from root to leaf", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    const homeRoute = routes.find((r) => r.pattern === "/");

    expect(homeRoute).toBeDefined();
    expect(homeRoute!.layouts.length).toBeGreaterThan(0);
    // Root layout should be the first
    expect(homeRoute!.layouts[0]).toContain("layout.tsx");
  });

  it("detects dynamic segments", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    const blogRoute = routes.find((r) => r.pattern === "/blog/:slug");

    expect(blogRoute).toBeDefined();
    expect(blogRoute!.isDynamic).toBe(true);
    expect(blogRoute!.params).toEqual(["slug"]);
  });

  it("sorts static routes before dynamic routes at the same depth", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    // Verify that top-level static routes (e.g. /about) come before
    // top-level dynamic routes without static prefixes (e.g. /blog/:slug).
    // Note: dynamic routes with static prefixes (e.g. /_sites/:subdomain)
    // may legitimately sort before pure-dynamic routes due to precedence.
    const aboutIdx = routes.findIndex((r) => r.pattern === "/about");
    const blogIdx = routes.findIndex((r) => r.pattern === "/blog/:slug");

    expect(aboutIdx).not.toBe(-1);
    expect(blogIdx).not.toBe(-1);
    expect(aboutIdx).toBeLessThan(blogIdx);
  });
});

describe("matchAppRoute - URL matching", () => {
  it("matches static routes", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/");

    const aboutResult = matchAppRoute("/about", routes);
    expect(aboutResult).not.toBeNull();
    expect(aboutResult!.route.pattern).toBe("/about");
  });

  it("matches dynamic routes and extracts params", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/blog/hello-world", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/blog/:slug");
    expect(result!.params).toEqual({ slug: "hello-world" });
  });

  it("returns null for unmatched routes", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/nonexistent", routes);
    expect(result).toBeNull();
  });

  it("matches API route handlers", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/api/hello", routes);
    expect(result).not.toBeNull();
    expect(result!.route.routePath).toBeTruthy();
  });

  it("route groups are transparent in URL pattern", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // (marketing)/features -> /features (no "(marketing)" in URL)
    expect(patterns).toContain("/features");
    expect(patterns.some((p) => p.includes("marketing"))).toBe(false);
  });

  it("matches catch-all routes with multiple segments", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/docs/getting-started/install", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/docs/:slug+");
    expect(result!.params.slug).toEqual(["getting-started", "install"]);
  });

  it("matches catch-all routes with single segment", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/docs/intro", routes);
    expect(result).not.toBeNull();
    expect(result!.params.slug).toEqual(["intro"]);
  });

  it("does not match catch-all with zero segments", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);
    // /docs alone should NOT match [...slug]
    const result = matchAppRoute("/docs", routes);
    expect(result).toBeNull();
  });

  it("matches optional catch-all with zero segments", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/optional", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/optional/:path*");
    expect(result!.params.path).toEqual([]);
  });

  it("matches optional catch-all with multiple segments", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/optional/a/b/c", routes);
    expect(result).not.toBeNull();
    expect(result!.params.path).toEqual(["a", "b", "c"]);
  });

  it("discovers template.tsx files", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    // Root template should be discovered for the home page
    const homeRoute = routes.find((r) => r.pattern === "/");
    expect(homeRoute).toBeDefined();
    expect(homeRoute!.templates.length).toBeGreaterThan(0);
    expect(homeRoute!.templates[0]).toContain("template");
  });

  it("includes templates array even when no template exists", async () => {
    const routes = await appRouter(APP_FIXTURE_DIR);

    // All routes should have a templates array (may be empty or populated)
    for (const route of routes) {
      expect(Array.isArray(route.templates)).toBe(true);
    }
  });

  it("@slot directories do not appear in URL patterns", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // No pattern should contain "@team" or "@analytics"
    expect(patterns.some((p) => p.includes("@"))).toBe(false);
    // Specifically, there should be no route like /dashboard/@team
    expect(patterns).not.toContain("/dashboard/@team");
    expect(patterns).not.toContain("/dashboard/@analytics");
  });

  it("@slot/page.tsx files do not create standalone routes", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // Slot pages should not generate their own routes
    expect(patterns).not.toContain("/dashboard/team");
    expect(patterns).not.toContain("/dashboard/analytics");
  });

  it("discovers parallel slots on dashboard route", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const dashboardRoute = routes.find((r) => r.pattern === "/dashboard");

    expect(dashboardRoute).toBeDefined();
    expect(dashboardRoute!.parallelSlots.length).toBe(2);

    const slotNames = dashboardRoute!.parallelSlots.map((s) => s.name).sort();
    expect(slotNames).toEqual(["analytics", "team"]);
  });

  it("parallel slot pages and defaults are discovered", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const dashboardRoute = routes.find((r) => r.pattern === "/dashboard");
    expect(dashboardRoute).toBeDefined();

    const teamSlot = dashboardRoute!.parallelSlots.find((s) => s.name === "team");
    expect(teamSlot).toBeDefined();
    expect(teamSlot!.pagePath).not.toBeNull();
    expect(teamSlot!.pagePath).toContain("@team");
    expect(teamSlot!.defaultPath).not.toBeNull();
    expect(teamSlot!.defaultPath).toContain("@team");

    const analyticsSlot = dashboardRoute!.parallelSlots.find((s) => s.name === "analytics");
    expect(analyticsSlot).toBeDefined();
    expect(analyticsSlot!.pagePath).not.toBeNull();
    expect(analyticsSlot!.defaultPath).not.toBeNull();
  });

  it("discovers layout.tsx inside parallel slot directories", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const dashboardRoute = routes.find((r) => r.pattern === "/dashboard");
    expect(dashboardRoute).toBeDefined();

    // @team has a layout.tsx
    const teamSlot = dashboardRoute!.parallelSlots.find((s) => s.name === "team");
    expect(teamSlot).toBeDefined();
    expect(teamSlot!.layoutPath).not.toBeNull();
    expect(teamSlot!.layoutPath).toContain("@team");
    expect(teamSlot!.layoutPath).toContain("layout.tsx");

    // @analytics does NOT have a layout.tsx
    const analyticsSlot = dashboardRoute!.parallelSlots.find((s) => s.name === "analytics");
    expect(analyticsSlot).toBeDefined();
    expect(analyticsSlot!.layoutPath).toBeNull();
  });

  it("inherited parallel slots preserve layoutPath from parent", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const settingsRoute = routes.find((r) => r.pattern === "/dashboard/settings");
    expect(settingsRoute).toBeDefined();

    // @team slot inherited from dashboard should still have layoutPath
    const teamSlot = settingsRoute!.parallelSlots.find((s) => s.name === "team");
    expect(teamSlot).toBeDefined();
    expect(teamSlot!.layoutPath).not.toBeNull();
    expect(teamSlot!.layoutPath).toContain("@team");
  });

  it("routes without @slot dirs have empty parallelSlots", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const homeRoute = routes.find((r) => r.pattern === "/");

    expect(homeRoute).toBeDefined();
    expect(homeRoute!.parallelSlots).toEqual([]);
  });

  it("decodes URL-encoded directory names into URL patterns", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // %5Fsites directory should decode to _sites in the URL pattern
    expect(patterns).toContain("/_sites/:subdomain");
    // The raw percent-encoded form should NOT appear
    expect(patterns.some((p) => p.includes("%5F"))).toBe(false);
  });

  it("matches requests against decoded URL-encoded routes", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/_sites/my-site", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/_sites/:subdomain");
    expect(result!.params).toEqual({ subdomain: "my-site" });
  });

  it("prioritizes static-prefix routes over bare catch-all routes", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);

    // /_sites/:subdomain has a static prefix "_sites" and should sort
    // before bare dynamic routes like /:slug at the same depth
    const sitesIdx = routes.findIndex((r) => r.pattern === "/_sites/:subdomain");
    const optionalCatchAllIdx = routes.findIndex((r) => r.pattern === "/optional/:path*");

    expect(sitesIdx).not.toBe(-1);
    expect(optionalCatchAllIdx).not.toBe(-1);
    // Static-prefix route should come before optional catch-all
    expect(sitesIdx).toBeLessThan(optionalCatchAllIdx);
  });

  it("child routes inherit parent parallel slots with default.tsx fallback", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const settingsRoute = routes.find((r) => r.pattern === "/dashboard/settings");

    expect(settingsRoute).toBeDefined();
    // Settings inherits @team and @analytics from dashboard layout
    expect(settingsRoute!.parallelSlots.length).toBe(2);

    const slotNames = settingsRoute!.parallelSlots.map((s) => s.name).sort();
    expect(slotNames).toEqual(["analytics", "team"]);

    // Inherited slots should NOT have pagePath (page.tsx is for /dashboard only)
    const teamSlot = settingsRoute!.parallelSlots.find((s) => s.name === "team");
    expect(teamSlot).toBeDefined();
    expect(teamSlot!.pagePath).toBeNull();
    // But should have defaultPath
    expect(teamSlot!.defaultPath).not.toBeNull();
    expect(teamSlot!.defaultPath).toContain("@team");

    const analyticsSlot = settingsRoute!.parallelSlots.find((s) => s.name === "analytics");
    expect(analyticsSlot).toBeDefined();
    expect(analyticsSlot!.pagePath).toBeNull();
    expect(analyticsSlot!.defaultPath).not.toBeNull();
    expect(analyticsSlot!.defaultPath).toContain("@analytics");
  });

  it("discovers intercepting routes inside parallel slots", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const feedRoute = routes.find((r) => r.pattern === "/feed");

    expect(feedRoute).toBeDefined();
    expect(feedRoute!.parallelSlots.length).toBe(1);

    const modalSlot = feedRoute!.parallelSlots.find((s) => s.name === "modal");
    expect(modalSlot).toBeDefined();
    expect(modalSlot!.interceptingRoutes.length).toBe(1);

    const intercept = modalSlot!.interceptingRoutes[0];
    expect(intercept.convention).toBe("...");
    expect(intercept.targetPattern).toBe("/photos/:id");
    expect(intercept.params).toEqual(["id"]);
    expect(intercept.pagePath).toContain("(...)photos");
  });

  it("intercepting route pages are not standalone routes", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // The intercepting page should not create a standalone route at its intercept path
    // (it lives inside @modal which is filtered from route discovery)
    expect(patterns.some((p) => p.includes("("))).toBe(false);
    // But the actual target route should exist
    expect(patterns).toContain("/photos/:id");
  });

  it("discovers the full photo page as a regular route", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const photoRoute = routes.find((r) => r.pattern === "/photos/:id");

    expect(photoRoute).toBeDefined();
    expect(photoRoute!.isDynamic).toBe(true);
    expect(photoRoute!.params).toEqual(["id"]);
    expect(photoRoute!.pagePath).toContain("photos/[id]/page.tsx");
  });

  it("discovers forbidden.tsx boundary file at the root", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const homeRoute = routes.find((r) => r.pattern === "/");
    expect(homeRoute).toBeDefined();
    expect(homeRoute!.forbiddenPath).toBeTruthy();
    expect(homeRoute!.forbiddenPath).toContain("forbidden.tsx");
  });

  it("discovers unauthorized.tsx boundary file at the root", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const homeRoute = routes.find((r) => r.pattern === "/");
    expect(homeRoute).toBeDefined();
    expect(homeRoute!.unauthorizedPath).toBeTruthy();
    expect(homeRoute!.unauthorizedPath).toContain("unauthorized.tsx");
  });

  // --- Parallel slot sub-routes ---

  it("generates routes for nested pages inside parallel slots", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    // @team/members/page.tsx should create a route at /dashboard/members
    const membersRoute = routes.find((r) => r.pattern === "/dashboard/members");
    expect(membersRoute).toBeDefined();
  });

  it("slot sub-route uses parent default.tsx as page", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const membersRoute = routes.find((r) => r.pattern === "/dashboard/members");
    expect(membersRoute).toBeDefined();
    // The children slot uses dashboard/default.tsx as the page component
    expect(membersRoute!.pagePath).not.toBeNull();
    expect(membersRoute!.pagePath).toContain("default.tsx");
    expect(membersRoute!.pagePath).toContain("dashboard");
  });

  it("slot sub-route has matching slot with sub-page path", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const membersRoute = routes.find((r) => r.pattern === "/dashboard/members");
    expect(membersRoute).toBeDefined();

    // @team slot should point to the sub-page
    const teamSlot = membersRoute!.parallelSlots.find((s) => s.name === "team");
    expect(teamSlot).toBeDefined();
    expect(teamSlot!.pagePath).not.toBeNull();
    expect(teamSlot!.pagePath).toContain("@team");
    expect(teamSlot!.pagePath).toContain("members");

    // @analytics slot has no members sub-page, should have null pagePath
    const analyticsSlot = membersRoute!.parallelSlots.find((s) => s.name === "analytics");
    expect(analyticsSlot).toBeDefined();
    expect(analyticsSlot!.pagePath).toBeNull();
    // But should still have defaultPath
    expect(analyticsSlot!.defaultPath).not.toBeNull();
  });

  it("slot sub-route inherits parent layouts", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const membersRoute = routes.find((r) => r.pattern === "/dashboard/members");
    const dashboardRoute = routes.find((r) => r.pattern === "/dashboard");
    expect(membersRoute).toBeDefined();
    expect(dashboardRoute).toBeDefined();

    // Should have same layouts as the parent route
    expect(membersRoute!.layouts).toEqual(dashboardRoute!.layouts);
  });
});
