import { describe, it, expect } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import {
  buildAppRouteGraph,
  type AppRoute,
} from "../packages/vinext/src/routing/app-route-graph.js";

const EMPTY_PAGE = "export default function Page() { return null; }\n";
const EMPTY_LAYOUT = "export default function Layout({ children }) { return children; }\n";
const EMPTY_ROUTE = "export async function GET() { return Response.json({ ok: true }); }\n";

async function withTempApp<T>(run: (appDir: string) => Promise<T>): Promise<T> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-app-route-graph-"));
  const appDir = path.join(tmpDir, "app");

  try {
    await mkdir(appDir, { recursive: true });
    return await run(appDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function writeAppFile(appDir: string, relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(appDir, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function findRoute(routes: AppRoute[], pattern: string): AppRoute {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (!route) {
    throw new Error(`Expected route ${pattern} to be materialized`);
  }
  return route;
}

describe("App Router route graph builder", () => {
  it("materializes pages, handlers, layouts, and inherited parallel slots", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/settings/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/api/route.ts", EMPTY_ROUTE);
      await writeAppFile(appDir, "dashboard/@team/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@team/default.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      expect(graph.routes.map((route) => route.pattern)).toEqual([
        "/dashboard",
        "/dashboard/api",
        "/dashboard/settings",
      ]);

      const dashboard = findRoute(graph.routes, "/dashboard");
      expect(dashboard.layouts).toEqual([
        path.join(appDir, "layout.tsx"),
        path.join(appDir, "dashboard/layout.tsx"),
      ]);
      expect(dashboard.parallelSlots).toHaveLength(1);
      expect(dashboard.parallelSlots[0]).toMatchObject({
        key: "team@dashboard/@team",
        name: "team",
        pagePath: path.join(appDir, "dashboard/@team/page.tsx"),
        defaultPath: path.join(appDir, "dashboard/@team/default.tsx"),
        layoutIndex: 1,
        routeSegments: [],
      });

      const settings = findRoute(graph.routes, "/dashboard/settings");
      expect(settings.parallelSlots[0]).toMatchObject({
        key: "team@dashboard/@team",
        name: "team",
        pagePath: null,
        defaultPath: path.join(appDir, "dashboard/@team/default.tsx"),
        layoutIndex: 1,
        routeSegments: null,
      });

      const handler = findRoute(graph.routes, "/dashboard/api");
      expect(handler).toMatchObject({
        pagePath: null,
        routePath: path.join(appDir, "dashboard/api/route.ts"),
      });
    });
  });

  it("materializes synthetic routes from nested parallel slot pages", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@team/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@team/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@team/members/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      expect(graph.routes.map((route) => route.pattern)).toEqual([
        "/dashboard",
        "/dashboard/members",
      ]);

      const members = findRoute(graph.routes, "/dashboard/members");
      expect(members).toMatchObject({
        pagePath: path.join(appDir, "dashboard/default.tsx"),
        routePath: null,
        routeSegments: ["dashboard", "members"],
        patternParts: ["dashboard", "members"],
      });
      expect(members.parallelSlots[0]).toMatchObject({
        key: "team@dashboard/@team",
        name: "team",
        pagePath: path.join(appDir, "dashboard/@team/members/page.tsx"),
        routeSegments: ["members"],
      });
    });
  });

  it("skips synthetic routes that structurally conflict with existing page routes", async () => {
    // A slot sub-page like @feed/[name]/page.tsx under /shop would create /shop/:name,
    // but if /shop/[id]/page.tsx already exists (route /shop/:id), the synthetic route
    // must be skipped — validateRoutePatterns rejects different slug names at the same
    // dynamic path. The slot content is resolved at render time by findMirroredSlotPage.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/[id]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@feed/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@feed/[name]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern).sort();

      // /shop/:id from shop/[id]/page.tsx must exist
      expect(patterns).toContain("/shop/:id");
      // /shop/:name from the slot sub-page must NOT be materialized
      expect(patterns).not.toContain("/shop/:name");
      // The non-conflicting parent route /shop should still exist
      expect(patterns).toContain("/shop");
    });
  });

  it("does not create synthetic routes under route-handler-only parents", async () => {
    // Route handlers have pagePath: null but are NOT layout-only UI routes.
    // They must not enter discoverSlotSubRoutes, or an ancestor slot like
    // @feed/foo/page.tsx could materialise a nonsense synthetic route under
    // /api/foo.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "@feed/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@feed/foo/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "api/route.ts", EMPTY_ROUTE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern).sort();

      // /api from the route handler must exist
      expect(patterns).toContain("/api");
      // /api/foo must NOT be materialised from the route handler entry
      expect(patterns).not.toContain("/api/foo");
      // /foo from the ancestor slot must still be discovered normally
      expect(patterns).toContain("/foo");
    });
  });

  it("skips structural conflicts against synthetic routes created earlier in the same pass", async () => {
    // Two slot sub-pages with different param names under the same parent
    // should not both be materialised. The first synthetic route (/shop/:id)
    // must block the second (/shop/:name), or validateRoutePatterns will
    // reject the build with "different slug names".
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@a/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@a/[id]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@b/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@b/[name]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern).sort();

      // Only one of /shop/:id or /shop/:name should be materialised
      const conflictingSyntheticPatterns = patterns.filter(
        (pattern) => pattern === "/shop/:id" || pattern === "/shop/:name",
      );
      expect(conflictingSyntheticPatterns).toHaveLength(1);
      expect(patterns).toContain("/shop");
    });
  });

  it("keeps route groups transparent in materialized URL patterns", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/about/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      expect(graph.routes.map((route) => route.pattern)).toEqual(["/about"]);

      const about = findRoute(graph.routes, "/about");
      expect(about).toMatchObject({
        pagePath: path.join(appDir, "(marketing)/about/page.tsx"),
        routeSegments: ["(marketing)", "about"],
        patternParts: ["about"],
      });
    });
  });

  it("links inherited parallel slot to a mirrored sub-page (literal segments)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "about/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/about/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const about = findRoute(graph.routes, "/about");
      expect(about.parallelSlots).toHaveLength(1);
      expect(about.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: path.join(appDir, "@breadcrumbs/about/page.tsx"),
        defaultPath: path.join(appDir, "@breadcrumbs/default.tsx"),
        routeSegments: ["about"],
      });
    });
  });

  it("links inherited parallel slot to a mirrored sub-page (catch-all segments)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[...slug]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/[...slug]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const slug = findRoute(graph.routes, "/:slug+");
      expect(slug.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: path.join(appDir, "@breadcrumbs/[...slug]/page.tsx"),
        routeSegments: ["[...slug]"],
      });
    });
  });

  it("falls back to default when no mirrored sub-page exists in the inherited slot", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "about/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const about = findRoute(graph.routes, "/about");
      expect(about.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: null,
        defaultPath: path.join(appDir, "@breadcrumbs/default.tsx"),
        routeSegments: null,
      });
    });
  });

  it("links inherited parallel slot to a mirror across a route group", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/about/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/about/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const about = findRoute(graph.routes, "/about");
      expect(about.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: path.join(appDir, "@breadcrumbs/about/page.tsx"),
        defaultPath: path.join(appDir, "@breadcrumbs/default.tsx"),
        routeSegments: ["about"],
      });
    });
  });

  it("mirrors across multiple inherited segments", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/items/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/shop/items/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const items = findRoute(graph.routes, "/shop/items");
      expect(items.parallelSlots[0]).toMatchObject({
        pagePath: path.join(appDir, "@breadcrumbs/shop/items/page.tsx"),
        routeSegments: ["shop", "items"],
      });
    });
  });

  it("captures distinct slotPatternParts/slotParamNames when slot and route use different param names", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/[id]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/shop/[name]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const route = findRoute(graph.routes, "/shop/:id");
      expect(route.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: path.join(appDir, "@breadcrumbs/shop/[name]/page.tsx"),
        routeSegments: ["shop", "[name]"],
        slotPatternParts: ["shop", ":name"],
        slotParamNames: ["name"],
      });
    });
  });

  it("mirrors when the slot is owned at an intermediate ancestor (not appDir)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "shop/items/detail/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@sidebar/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "shop/@sidebar/items/detail/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const detail = findRoute(graph.routes, "/shop/items/detail");
      expect(detail.parallelSlots[0]).toMatchObject({
        name: "sidebar",
        pagePath: path.join(appDir, "shop/@sidebar/items/detail/page.tsx"),
        defaultPath: path.join(appDir, "shop/@sidebar/default.tsx"),
        routeSegments: ["items", "detail"],
        slotPatternParts: ["shop", "items", "detail"],
      });
    });
  });

  it("rejects page and route handlers that materialize to the same URL", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/route.ts", EMPTY_ROUTE);

      await expect(buildAppRouteGraph(appDir, createValidFileMatcher())).rejects.toThrow(
        "Conflicting route and page at /dashboard",
      );
    });
  });
});
