import { describe, it, expect } from "vite-plus/test";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  pagesRouter,
  matchRoute,
  apiRouter,
  type Route,
} from "../packages/vinext/src/routing/pages-router.js";
import {
  appRouter,
  matchAppRoute,
  invalidateAppRouteCache,
  type AppRoute,
} from "../packages/vinext/src/routing/app-router.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic/pages");
const EMPTY_PAGE = "export default function Page() { return null; }\n";
const EMPTY_ROUTE = "export async function GET() { return Response.json({ ok: true }); }\n";

async function withTempDir<T>(prefix: string, run: (tmpDir: string) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function makeTestAppRoute(
  pattern: string,
  patternParts: string[],
): AppRoute & { patternParts: string[] } {
  return {
    pattern,
    patternParts,
    pagePath: null,
    routePath: null,
    layouts: [],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [],
    notFoundPath: null,
    notFoundPaths: [],
    forbiddenPath: null,
    unauthorizedPath: null,
    routeSegments: [],
    layoutTreePositions: [],
    isDynamic: pattern.includes(":"),
    params: [],
  };
}

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
    const lastStaticIndex = routes.findIndex((r) => r === staticRoutes[staticRoutes.length - 1]);
    const firstDynamicIndex = routes.findIndex((r) => r === dynamicRoutes[0]);

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

  it("rejects non-terminal catch-all routes during discovery", async () => {
    await withTempDir("vinext-pages-nonterminal-catchall-", async (tmpDir) => {
      const pagesDir = path.join(tmpDir, "pages");
      await mkdir(path.join(pagesDir, "[...slug]", "edit"), { recursive: true });
      await writeFile(path.join(pagesDir, "[...slug]", "edit", "index.tsx"), EMPTY_PAGE);

      const routes = await pagesRouter(pagesDir);

      expect(routes).toEqual([]);
    });
  });

  it("rejects non-terminal optional catch-all routes during discovery", async () => {
    await withTempDir("vinext-pages-nonterminal-optional-catchall-", async (tmpDir) => {
      const pagesDir = path.join(tmpDir, "pages");
      await mkdir(path.join(pagesDir, "[[...slug]]", "edit"), { recursive: true });
      await writeFile(path.join(pagesDir, "[[...slug]]", "edit", "index.tsx"), EMPTY_PAGE);

      const routes = await pagesRouter(pagesDir);

      expect(routes).toEqual([]);
    });
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

  it("preserves encoded slashes within a single static segment", () => {
    const encodedRoute = {
      pattern: "/a%2Fb",
      patternParts: ["a%2Fb"],
      filePath: "/tmp/pages/a%2Fb.tsx",
      isDynamic: false,
      params: [],
    } as Route;
    const nestedRoute = {
      pattern: "/a/b",
      patternParts: ["a", "b"],
      filePath: "/tmp/pages/a/b.tsx",
      isDynamic: false,
      params: [],
    } as Route;

    expect(matchRoute("/a%2Fb", [encodedRoute, nestedRoute])?.route.pattern).toBe("/a%2Fb");
    expect(matchRoute("/a/b", [encodedRoute, nestedRoute])?.route.pattern).toBe("/a/b");
    // Lowercase %2f should also match: normalizePathnameForRouteMatch decodes
    // then re-encodes via encodeURIComponent, which always produces uppercase.
    expect(matchRoute("/a%2fb", [encodedRoute, nestedRoute])?.route.pattern).toBe("/a%2Fb");
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

  it("rejects malformed non-terminal catch-all patterns in the matcher", () => {
    const malformedRoute = {
      pattern: "/:slug+/edit",
      patternParts: [":slug+", "edit"],
      filePath: "/tmp/pages/[...slug]/edit/index.tsx",
      isDynamic: true,
      params: ["slug"],
    } as Route;

    expect(matchRoute("/foo", [malformedRoute])).toBeNull();
    expect(matchRoute("/foo/edit", [malformedRoute])).toBeNull();
  });

  it("rejects malformed non-terminal optional catch-all patterns in the matcher", () => {
    const malformedRoute = {
      pattern: "/:slug*/edit",
      patternParts: [":slug*", "edit"],
      filePath: "/tmp/pages/[[...slug]]/edit/index.tsx",
      isDynamic: true,
      params: ["slug"],
    } as Route;

    expect(matchRoute("/", [malformedRoute])).toBeNull();
    expect(matchRoute("/foo/edit", [malformedRoute])).toBeNull();
  });

  it("skips malformed catch-all patterns and continues to later valid routes", () => {
    const malformedRoute = {
      pattern: "/:slug+/edit",
      patternParts: [":slug+", "edit"],
      filePath: "/tmp/pages/[...slug]/edit/index.tsx",
      isDynamic: true,
      params: ["slug"],
    } as Route;
    const validRoute = {
      pattern: "/foo",
      patternParts: ["foo"],
      filePath: "/tmp/pages/foo.tsx",
      isDynamic: false,
      params: [],
    } as Route;

    const result = matchRoute("/foo", [malformedRoute, validRoute]);

    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/foo");
  });
});

describe("apiRouter - route discovery", () => {
  it("rejects non-terminal catch-all API routes during discovery", async () => {
    await withTempDir("vinext-api-nonterminal-catchall-", async (tmpDir) => {
      const pagesDir = path.join(tmpDir, "pages");
      await mkdir(path.join(pagesDir, "api", "[...slug]"), { recursive: true });
      await writeFile(path.join(pagesDir, "api", "[...slug]", "edit.ts"), EMPTY_ROUTE);

      const routes = await apiRouter(pagesDir);

      expect(routes).toEqual([]);
    });
  });

  it("rejects non-terminal optional catch-all API routes during discovery", async () => {
    await withTempDir("vinext-api-nonterminal-optional-catchall-", async (tmpDir) => {
      const pagesDir = path.join(tmpDir, "pages");
      await mkdir(path.join(pagesDir, "api", "[[...slug]]"), { recursive: true });
      await writeFile(path.join(pagesDir, "api", "[[...slug]]", "edit.ts"), EMPTY_ROUTE);

      const routes = await apiRouter(pagesDir);

      expect(routes).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------
// App Router routing tests
// ---------------------------------------------------------------

const APP_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/app-basic/app");

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

  it("rejects non-terminal catch-all pages during discovery", async () => {
    await withTempDir("vinext-app-nonterminal-catchall-page-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "[...slug]", "edit"), { recursive: true });
      await writeFile(path.join(appDir, "[...slug]", "edit", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      expect(routes).toEqual([]);
    });
  });

  it("rejects non-terminal optional catch-all route handlers during discovery", async () => {
    await withTempDir("vinext-app-nonterminal-optional-catchall-route-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "[[...slug]]", "edit"), { recursive: true });
      await writeFile(path.join(appDir, "[[...slug]]", "edit", "route.ts"), EMPTY_ROUTE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      expect(routes).toEqual([]);
    });
  });

  it("rejects non-terminal catch-all routes even when the suffix is behind a route group", async () => {
    await withTempDir("vinext-app-nonterminal-catchall-group-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "[...slug]", "(admin)", "edit"), { recursive: true });
      await writeFile(path.join(appDir, "[...slug]", "(admin)", "edit", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      expect(routes).toEqual([]);
    });
  });

  it("allows terminal catch-all when only transparent route groups follow on disk", async () => {
    await withTempDir("vinext-app-terminal-catchall-group-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "[...slug]", "(admin)"), { recursive: true });
      await writeFile(path.join(appDir, "[...slug]", "(admin)", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      expect(routes.map((route) => route.pattern)).toEqual(["/:slug+"]);
    });
  });

  it("allows terminal optional catch-all when only transparent route groups follow on disk", async () => {
    await withTempDir("vinext-app-terminal-optional-catchall-group-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "[[...slug]]", "(admin)"), { recursive: true });
      await writeFile(path.join(appDir, "[[...slug]]", "(admin)", "route.ts"), EMPTY_ROUTE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      expect(routes.map((route) => route.pattern)).toEqual(["/:slug*"]);
    });
  });

  it("rejects non-terminal catch-all in synthetic @slot subroutes", async () => {
    await withTempDir("vinext-app-slot-nonterminal-catchall-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "dashboard", "@modal", "[...slug]", "edit"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "dashboard", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "@modal", "default.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "dashboard", "@modal", "[...slug]", "edit", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/dashboard");
      expect(patterns).not.toContain("/dashboard/:slug+/edit");
    });
  });

  it("rejects non-terminal optional catch-all in synthetic @slot subroutes", async () => {
    await withTempDir("vinext-app-slot-nonterminal-optional-catchall-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "dashboard", "@modal", "[[...slug]]", "edit"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "dashboard", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "@modal", "default.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "dashboard", "@modal", "[[...slug]]", "edit", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/dashboard");
      expect(patterns).not.toContain("/dashboard/:slug*/edit");
    });
  });

  it("allows terminal synthetic @slot catch-all when only route groups follow", async () => {
    await withTempDir("vinext-app-slot-terminal-catchall-group-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "dashboard", "@modal", "[...slug]", "(admin)"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "dashboard", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "@modal", "default.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "dashboard", "@modal", "[...slug]", "(admin)", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/dashboard/:slug+");
      const match = matchAppRoute("/dashboard/a/b", routes);
      expect(match).not.toBeNull();
      expect(match!.route.pattern).toBe("/dashboard/:slug+");
      expect(match!.params.slug).toEqual(["a", "b"]);
    });
  });

  it("does not create nested @slot sub-routes without a children default fallback", async () => {
    await withTempDir("vinext-app-slot-missing-children-default-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "inbox", "@modal", "profile"), { recursive: true });
      await writeFile(path.join(appDir, "inbox", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "inbox", "@modal", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "inbox", "@modal", "profile", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/inbox");
      expect(patterns).not.toContain("/inbox/profile");
      expect(matchAppRoute("/inbox/profile", routes)).toBeNull();
    });
  });

  it("does not discover nested @slot sub-routes when the slot root has no page or default", async () => {
    await withTempDir("vinext-app-slot-nested-only-rootless-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "inbox", "@modal", "profile"), { recursive: true });
      await writeFile(path.join(appDir, "inbox", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "inbox", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "inbox", "@modal", "profile", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/inbox");
      expect(patterns).not.toContain("/inbox/profile");
      expect(matchAppRoute("/inbox/profile", routes)).toBeNull();
    });
  });

  it("rejects non-terminal catch-all intercept targets", async () => {
    await withTempDir("vinext-app-intercept-nonterminal-catchall-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "feed", "@modal", "(...)photos", "[...slug]", "edit"), {
        recursive: true,
      });
      await mkdir(path.join(appDir, "photos", "[id]"), { recursive: true });
      await writeFile(path.join(appDir, "feed", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "photos", "[id]", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "feed", "@modal", "(...)photos", "[...slug]", "edit", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const feedRoute = routes.find((route) => route.pattern === "/feed");

      expect(feedRoute).toBeDefined();
      const modalSlot = feedRoute!.parallelSlots.find((slot) => slot.name === "modal");
      expect(modalSlot).toBeUndefined();
    });
  });

  it("rejects non-terminal optional catch-all intercept targets", async () => {
    await withTempDir("vinext-app-intercept-nonterminal-optional-catchall-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "feed", "@modal", "(...)photos", "[[...slug]]", "edit"), {
        recursive: true,
      });
      await mkdir(path.join(appDir, "photos", "[id]"), { recursive: true });
      await writeFile(path.join(appDir, "feed", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "photos", "[id]", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "feed", "@modal", "(...)photos", "[[...slug]]", "edit", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const feedRoute = routes.find((route) => route.pattern === "/feed");

      expect(feedRoute).toBeDefined();
      const modalSlot = feedRoute!.parallelSlots.find((slot) => slot.name === "modal");
      expect(modalSlot).toBeUndefined();
    });
  });

  it("allows terminal catch-all intercept targets when only route groups follow", async () => {
    await withTempDir("vinext-app-intercept-terminal-catchall-group-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "feed", "@modal", "(...)photos", "[...slug]", "(admin)"), {
        recursive: true,
      });
      await mkdir(path.join(appDir, "photos", "[id]"), { recursive: true });
      await writeFile(path.join(appDir, "feed", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "photos", "[id]", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "feed", "@modal", "(...)photos", "[...slug]", "(admin)", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const feedRoute = routes.find((route) => route.pattern === "/feed");

      expect(feedRoute).toBeDefined();
      const modalSlot = feedRoute!.parallelSlots.find((slot) => slot.name === "modal");
      expect(modalSlot).toBeDefined();
      expect(modalSlot!.interceptingRoutes).toHaveLength(1);
      expect(modalSlot!.interceptingRoutes[0].targetPattern).toBe("/photos/:slug+");
      expect(modalSlot!.interceptingRoutes[0].params).toEqual(["slug"]);
    });
  });

  it("(..) climbs visible route segments, not filesystem dirs (route group between segments)", async () => {
    // Bug: computeInterceptTarget uses path.dirname() which counts filesystem dirs,
    // but (..) should count visible route segments (skipping route groups).
    // Structure: app/a/(group)/b/@modal/(..)(..)target/page.tsx
    // Visible path: /a/b → (..)(..) should climb 2 visible segments → root → /target
    // Bug produces: /a/target (climbs past "b" and "(group)", lands on "a")
    await withTempDir("vinext-app-intercept-route-group-climb-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "a", "(group)", "b", "@modal", "(..)(..)target"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "a", "(group)", "b", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "a", "(group)", "b", "@modal", "(..)(..)target", "page.tsx"),
        EMPTY_PAGE,
      );
      // The actual target route
      await mkdir(path.join(appDir, "target"), { recursive: true });
      await writeFile(path.join(appDir, "target", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const bRoute = routes.find((r) => r.pattern === "/a/b");
      expect(bRoute).toBeDefined();

      const modalSlot = bRoute!.parallelSlots.find((s) => s.name === "modal");
      expect(modalSlot).toBeDefined();
      expect(modalSlot!.interceptingRoutes).toHaveLength(1);
      // (..)(..) should climb 2 visible segments (b → a → root), landing at /target
      expect(modalSlot!.interceptingRoutes[0].targetPattern).toBe("/target");
    });
  });

  it("(..) with single route group between segments resolves correctly", async () => {
    // Structure: app/shop/(featured)/products/@modal/(..)cart/page.tsx
    // Visible path: /shop/products → (..) climbs 1 visible segment above products → /shop
    // Target: /shop/cart
    await withTempDir("vinext-app-intercept-single-group-climb-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "shop", "(featured)", "products", "@modal", "(..)cart"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "shop", "(featured)", "products", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "shop", "(featured)", "products", "@modal", "(..)cart", "page.tsx"),
        EMPTY_PAGE,
      );
      await mkdir(path.join(appDir, "shop", "cart"), { recursive: true });
      await writeFile(path.join(appDir, "shop", "cart", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const productsRoute = routes.find((r) => r.pattern === "/shop/products");
      expect(productsRoute).toBeDefined();

      const modalSlot = productsRoute!.parallelSlots.find((s) => s.name === "modal");
      expect(modalSlot).toBeDefined();
      expect(modalSlot!.interceptingRoutes).toHaveLength(1);
      expect(modalSlot!.interceptingRoutes[0].targetPattern).toBe("/shop/cart");
    });
  });

  it("(..) skips multiple consecutive route groups when climbing", async () => {
    // Structure: app/a/(g1)/(g2)/b/@modal/(..)(..)target/page.tsx
    // Visible path: /a/b → (..)(..) climbs 2 visible segments → root → /target
    await withTempDir("vinext-app-intercept-multi-group-climb-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "a", "(g1)", "(g2)", "b", "@modal", "(..)(..)target"), {
        recursive: true,
      });
      await writeFile(path.join(appDir, "a", "(g1)", "(g2)", "b", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "a", "(g1)", "(g2)", "b", "@modal", "(..)(..)target", "page.tsx"),
        EMPTY_PAGE,
      );
      await mkdir(path.join(appDir, "target"), { recursive: true });
      await writeFile(path.join(appDir, "target", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const bRoute = routes.find((r) => r.pattern === "/a/b");
      expect(bRoute).toBeDefined();

      const modalSlot = bRoute!.parallelSlots.find((s) => s.name === "modal");
      expect(modalSlot).toBeDefined();
      expect(modalSlot!.interceptingRoutes).toHaveLength(1);
      expect(modalSlot!.interceptingRoutes[0].targetPattern).toBe("/target");
    });
  });

  it("rejects sibling intercept targets that differ only by param name", async () => {
    await withTempDir("vinext-app-intercept-dynamic-conflict-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "feed", "@modal", "(.)photos", "[id]"), { recursive: true });
      await mkdir(path.join(appDir, "feed", "@modal", "(.)photos", "[slug]"), {
        recursive: true,
      });
      await mkdir(path.join(appDir, "feed", "photos", "[id]"), { recursive: true });
      await writeFile(path.join(appDir, "feed", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "feed", "photos", "[id]", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "feed", "@modal", "(.)photos", "[id]", "page.tsx"),
        EMPTY_PAGE,
      );
      await writeFile(
        path.join(appDir, "feed", "@modal", "(.)photos", "[slug]", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      await expect(appRouter(appDir)).rejects.toThrow(/different slug names/);
    });
  });

  it("excludes private folders (underscore prefix) from route discovery", async () => {
    await withTempDir("vinext-app-private-folder-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      // _components is a private folder — should be excluded
      await mkdir(path.join(appDir, "_components"), { recursive: true });
      await writeFile(path.join(appDir, "_components", "page.tsx"), EMPTY_PAGE);
      // _lib/utils is also private — nested private folder
      await mkdir(path.join(appDir, "_lib", "utils"), { recursive: true });
      await writeFile(path.join(appDir, "_lib", "utils", "page.tsx"), EMPTY_PAGE);
      // Regular routes should still be discovered
      await mkdir(path.join(appDir, "about"), { recursive: true });
      await writeFile(path.join(appDir, "about", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((r) => r.pattern);

      expect(patterns).toContain("/");
      expect(patterns).toContain("/about");
      expect(patterns).not.toContain("/_components");
      expect(patterns).not.toContain("/_lib/utils");
    });
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

  it("rejects malformed non-terminal catch-all patterns in the matcher", () => {
    const malformedRoute = makeTestAppRoute("/:slug+/edit", [":slug+", "edit"]);

    expect(matchAppRoute("/foo", [malformedRoute])).toBeNull();
    expect(matchAppRoute("/foo/edit", [malformedRoute])).toBeNull();
  });

  it("rejects malformed non-terminal optional catch-all patterns in the matcher", () => {
    const malformedRoute = makeTestAppRoute("/:slug*/edit", [":slug*", "edit"]);

    expect(matchAppRoute("/", [malformedRoute])).toBeNull();
    expect(matchAppRoute("/foo/edit", [malformedRoute])).toBeNull();
  });

  it("skips malformed catch-all patterns and continues to later valid routes", () => {
    const malformedRoute = makeTestAppRoute("/:slug+/edit", [":slug+", "edit"]);
    const validRoute = makeTestAppRoute("/foo", ["foo"]);

    const result = matchAppRoute("/foo", [malformedRoute, validRoute]);

    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/foo");
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

  it("keeps encoded slashes distinct from real nested routes", async () => {
    await withTempDir("vinext-app-encoded-slash-route-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");
      await mkdir(path.join(appDir, "a%2Fb"), { recursive: true });
      await mkdir(path.join(appDir, "a", "b"), { recursive: true });
      await writeFile(path.join(appDir, "a%2Fb", "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "a", "b", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const patterns = routes.map((route) => route.pattern);

      expect(patterns).toContain("/a%2Fb");
      expect(patterns).toContain("/a/b");

      expect(matchAppRoute("/a%2Fb", routes)?.route.pattern).toBe("/a%2Fb");
      expect(matchAppRoute("/a/b", routes)?.route.pattern).toBe("/a/b");
    });
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

  it("allows inherited intercepting slots to reuse the same target pattern", async () => {
    await withTempDir("vinext-app-intercept-inherited-slot-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");

      await mkdir(path.join(appDir, "intercepting-routes", "@modal", "(.)photo", "[id]"), {
        recursive: true,
      });
      await mkdir(path.join(appDir, "intercepting-routes", "photo", "[id]"), {
        recursive: true,
      });

      await writeFile(path.join(appDir, "layout.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "page.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "intercepting-routes", "layout.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "intercepting-routes", "page.tsx"), EMPTY_PAGE);
      await writeFile(
        path.join(appDir, "intercepting-routes", "photo", "[id]", "page.tsx"),
        EMPTY_PAGE,
      );
      await writeFile(
        path.join(appDir, "intercepting-routes", "@modal", "default.tsx"),
        EMPTY_PAGE,
      );
      await writeFile(
        path.join(appDir, "intercepting-routes", "@modal", "(.)photo", "[id]", "page.tsx"),
        EMPTY_PAGE,
      );

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);

      const galleryRoute = routes.find((route) => route.pattern === "/intercepting-routes");
      const detailRoute = routes.find(
        (route) => route.pattern === "/intercepting-routes/photo/:id",
      );

      expect(galleryRoute).toBeDefined();
      expect(detailRoute).toBeDefined();

      const galleryModal = galleryRoute!.parallelSlots.find((slot) => slot.name === "modal");
      const detailModal = detailRoute!.parallelSlots.find((slot) => slot.name === "modal");

      expect(galleryModal?.interceptingRoutes[0]?.targetPattern).toBe(
        "/intercepting-routes/photo/:id",
      );
      expect(detailModal?.interceptingRoutes[0]?.targetPattern).toBe(
        "/intercepting-routes/photo/:id",
      );
      expect(detailModal?.interceptingRoutes[0]?.pagePath).toBe(
        galleryModal?.interceptingRoutes[0]?.pagePath,
      );
    });
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

  // --- Hyphenated param names (issue #71) ---

  it("discovers optional catch-all with hyphenated param name [[...sign-in]]", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // [[...sign-in]] should produce :sign-in* pattern
    expect(patterns).toContain("/sign-in/:sign-in*");
  });

  it("hyphenated optional catch-all has correct params and isDynamic", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const route = routes.find((r) => r.pattern === "/sign-in/:sign-in*");

    expect(route).toBeDefined();
    expect(route!.isDynamic).toBe(true);
    expect(route!.params).toContain("sign-in");
  });

  it("matches hyphenated optional catch-all with zero segments", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/sign-in", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/sign-in/:sign-in*");
    expect(result!.params["sign-in"]).toEqual([]);
  });

  it("matches hyphenated optional catch-all with segments", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/sign-in/sso/callback", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/sign-in/:sign-in*");
    expect(result!.params["sign-in"]).toEqual(["sso", "callback"]);
  });

  it("discovers dynamic segment with hyphenated param name [auth-method]", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // [auth-method] should produce :auth-method pattern
    expect(patterns).toContain("/auth/:auth-method");
  });

  it("matches dynamic segment with hyphenated param name", async () => {
    invalidateAppRouteCache();
    const routes = await appRouter(APP_FIXTURE_DIR);

    const result = matchAppRoute("/auth/google", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/auth/:auth-method");
    expect(result!.params["auth-method"]).toBe("google");
  });

  // --- Inherited parallel slot priority ---

  it("closest ancestor parallel slot wins over farthest when same name exists at multiple levels", async () => {
    await withTempDir("vinext-app-parallel-slot-priority-", async (tmpDir) => {
      const appDir = path.join(tmpDir, "app");

      // Root-level @sidebar
      await mkdir(path.join(appDir, "@sidebar"), { recursive: true });
      await writeFile(path.join(appDir, "@sidebar", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "layout.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "page.tsx"), EMPTY_PAGE);

      // Dashboard-level @sidebar (closer ancestor to /dashboard/settings)
      await mkdir(path.join(appDir, "dashboard", "@sidebar"), { recursive: true });
      await writeFile(path.join(appDir, "dashboard", "@sidebar", "default.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "layout.tsx"), EMPTY_PAGE);
      await writeFile(path.join(appDir, "dashboard", "page.tsx"), EMPTY_PAGE);

      // The leaf route
      await mkdir(path.join(appDir, "dashboard", "settings"), { recursive: true });
      await writeFile(path.join(appDir, "dashboard", "settings", "page.tsx"), EMPTY_PAGE);

      invalidateAppRouteCache();
      const routes = await appRouter(appDir);
      const settingsRoute = routes.find((r) => r.pattern === "/dashboard/settings");
      expect(settingsRoute).toBeDefined();

      const sidebarSlot = settingsRoute!.parallelSlots.find((s) => s.name === "sidebar");
      expect(sidebarSlot).toBeDefined();

      // The dashboard-level @sidebar (closest ancestor) should win
      expect(sidebarSlot!.defaultPath).not.toBeNull();
      expect(sidebarSlot!.defaultPath).toContain(path.join("dashboard", "@sidebar"));
    });
  });
});

// --- Pages Router: hyphenated param names ---

describe("pagesRouter - hyphenated param names", () => {
  it("discovers optional catch-all with hyphenated param name [[...sign-up]]", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);
    const patterns = routes.map((r) => r.pattern);

    // [[...sign-up]] should produce :sign-up* pattern
    expect(patterns).toContain("/sign-up/:sign-up*");
  });

  it("hyphenated optional catch-all has correct params and isDynamic", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);
    const route = routes.find((r) => r.pattern === "/sign-up/:sign-up*");

    expect(route).toBeDefined();
    expect(route!.isDynamic).toBe(true);
    expect(route!.params).toContain("sign-up");
  });

  it("matches hyphenated optional catch-all with zero segments", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/sign-up", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/sign-up/:sign-up*");
    expect(result!.params["sign-up"]).toEqual([]);
  });

  it("matches hyphenated optional catch-all with segments", async () => {
    const routes = await pagesRouter(FIXTURE_DIR);

    const result = matchRoute("/sign-up/step/2", routes);
    expect(result).not.toBeNull();
    expect(result!.route.pattern).toBe("/sign-up/:sign-up*");
    expect(result!.params["sign-up"]).toEqual(["step", "2"]);
  });
});
