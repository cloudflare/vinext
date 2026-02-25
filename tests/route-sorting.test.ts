/**
 * Route sorting and validation tests — unique cases NOT covered by routing.test.ts.
 *
 * Mirrors test cases from Next.js test/unit/page-route-sorter.test.ts,
 * adapted for vinext's route format (colon params instead of bracket params).
 *
 * Tests that dynamic sorts before catch-all, deterministic ordering,
 * static-over-dynamic preference, patternToNextFormat conversion,
 * App Router route type discovery, and API route sorting.
 *
 * NOTE: Basic matchRoute/matchAppRoute edge cases (root, static, dynamic param
 * extraction, query stripping, trailing slash, catch-all, @slot filtering) are
 * tested in routing.test.ts — not duplicated here.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { pagesRouter, matchRoute, apiRouter, patternToNextFormat } from "../packages/vinext/src/routing/pages-router.js";
import { appRouter, invalidateAppRouteCache } from "../packages/vinext/src/routing/app-router.js";

const PAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic/pages");
const APP_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");

// ─── Pages Router sorting (mirrors Next.js page-route-sorter.test.ts) ───

describe("Pages Router route sorting", () => {
  it("dynamic routes come before catch-all routes", async () => {
    const routes = await pagesRouter(PAGES_DIR);
    const patterns = routes.map(r => r.pattern);

    // Find positions of dynamic params vs catch-all
    const dynamicIdx = patterns.findIndex(p => p.includes(":") && !p.includes("+") && !p.includes("*"));
    const catchAllIdx = patterns.findIndex(p => p.includes("+"));

    if (dynamicIdx !== -1 && catchAllIdx !== -1) {
      expect(dynamicIdx).toBeLessThan(catchAllIdx);
    }
  });

  it("sorts deterministically (alphabetic tiebreaker)", async () => {
    const routes1 = await pagesRouter(PAGES_DIR);
    const routes2 = await pagesRouter(PAGES_DIR);
    expect(routes1.map(r => r.pattern)).toEqual(routes2.map(r => r.pattern));
  });
});

// ─── Pages Router matchRoute — unique edge cases ────────────────────────

describe("Pages Router matchRoute (additional)", () => {
  it("prefers static over dynamic match", async () => {
    const routes = await pagesRouter(PAGES_DIR);
    // If there's both /about (static) and /:slug (dynamic)
    const result = matchRoute("/about", routes);
    expect(result).not.toBeNull();
    expect(result!.route.isDynamic).toBe(false);
  });
});

// ─── patternToNextFormat ────────────────────────────────────────────────

describe("patternToNextFormat", () => {
  it("converts dynamic :id to [id]", () => {
    expect(patternToNextFormat("/posts/:id")).toBe("/posts/[id]");
  });

  it("converts catch-all :slug+ to [...slug]", () => {
    expect(patternToNextFormat("/docs/:slug+")).toBe("/docs/[...slug]");
  });

  it("converts optional catch-all :slug* to [[...slug]]", () => {
    expect(patternToNextFormat("/:slug*")).toBe("/[[...slug]]");
  });

  it("handles multiple dynamic segments", () => {
    expect(patternToNextFormat("/:category/:id")).toBe("/[category]/[id]");
  });

  it("preserves static segments", () => {
    expect(patternToNextFormat("/about")).toBe("/about");
    expect(patternToNextFormat("/")).toBe("/");
  });

  it("handles mixed static and dynamic", () => {
    expect(patternToNextFormat("/blog/:year/:month/:slug")).toBe("/blog/[year]/[month]/[slug]");
  });

  it("converts hyphenated dynamic :auth-method to [auth-method]", () => {
    expect(patternToNextFormat("/auth/:auth-method")).toBe("/auth/[auth-method]");
  });

  it("converts hyphenated catch-all :sign-in+ to [...sign-in]", () => {
    expect(patternToNextFormat("/login/:sign-in+")).toBe("/login/[...sign-in]");
  });

  it("converts hyphenated optional catch-all :sign-up* to [[...sign-up]]", () => {
    expect(patternToNextFormat("/register/:sign-up*")).toBe("/register/[[...sign-up]]");
  });
});

// ─── App Router route sorting ───────────────────────────────────────────

describe("App Router route sorting (additional)", () => {
  it("discovers all expected route types", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_DIR);
    const patterns = routes.map(r => r.pattern);

    // Static routes
    expect(patterns).toContain("/");
    expect(patterns).toContain("/about");

    // Dynamic routes should exist
    const hasDynamic = patterns.some(p => p.includes(":"));
    expect(hasDynamic).toBe(true);
  });
});

// ─── API Router ─────────────────────────────────────────────────────────

describe("Pages Router API routes", () => {
  it("discovers API routes", async () => {
    const routes = await apiRouter(PAGES_DIR);
    expect(routes.length).toBeGreaterThan(0);
    const patterns = routes.map(r => r.pattern);
    expect(patterns.some(p => p.startsWith("/api/"))).toBe(true);
  });

  it("sorts static API routes before dynamic", async () => {
    const routes = await apiRouter(PAGES_DIR);
    const staticRoutes = routes.filter(r => !r.isDynamic);
    const dynamicRoutes = routes.filter(r => r.isDynamic);

    if (staticRoutes.length > 0 && dynamicRoutes.length > 0) {
      const lastStaticIdx = routes.indexOf(staticRoutes[staticRoutes.length - 1]);
      const firstDynamicIdx = routes.indexOf(dynamicRoutes[0]);
      expect(lastStaticIdx).toBeLessThan(firstDynamicIdx);
    }
  });
});
