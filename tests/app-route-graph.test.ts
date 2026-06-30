import { describe, it, expect, vi } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import {
  buildAppRouteGraph,
  findOwnerRouteForDir,
  type AppRouteGraphRoute,
  type RouteManifest,
} from "../packages/vinext/src/routing/app-route-graph.js";

// normalizePathSeparators is a platform-gated no-op on POSIX. CI never runs
// Windows, so force the Windows behavior to let the separator-mismatch tests
// below exercise the real normalization logic. Harmless for the other tests:
// POSIX paths contain no backslashes, so the replace is an identity for them.
vi.mock("../packages/vinext/src/utils/path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../packages/vinext/src/utils/path.js")>();
  return { ...actual, normalizePathSeparators: (p: string) => p.replace(/\\/g, "/") };
});

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

function findRoute(routes: readonly AppRouteGraphRoute[], pattern: string): AppRouteGraphRoute {
  const route = routes.find((candidate) => candidate.pattern === pattern);
  if (!route) {
    throw new Error(`Expected route ${pattern} to be materialized`);
  }
  return route;
}

function snapshotRouteManifest(manifest: RouteManifest) {
  return {
    graphVersion: manifest.graphVersion,
    routes: Array.from(manifest.segmentGraph.routes.entries()),
    layouts: Array.from(manifest.segmentGraph.layouts.entries()),
    pages: Array.from(manifest.segmentGraph.pages.entries()),
    routeHandlers: Array.from(manifest.segmentGraph.routeHandlers.entries()),
    templates: Array.from(manifest.segmentGraph.templates.entries()),
    slots: Array.from(manifest.segmentGraph.slots.entries()),
    defaults: Array.from(manifest.segmentGraph.defaults.entries()),
    slotBindings: Array.from(manifest.segmentGraph.slotBindings.entries()),
    interceptions: Array.from(manifest.segmentGraph.interceptions.entries()),
    interceptionsBySlotId: Array.from(manifest.segmentGraph.interceptionsBySlotId.entries()),
    boundaries: Array.from(manifest.segmentGraph.boundaries.entries()),
    rootBoundaries: Array.from(manifest.segmentGraph.rootBoundaries.entries()),
  };
}

async function withReverseLocaleCompare<T>(run: () => Promise<T>): Promise<T> {
  const originalLocaleCompare = Reflect.get(String.prototype, "localeCompare");
  if (typeof originalLocaleCompare !== "function") {
    throw new Error("Expected String.prototype.localeCompare to be a function");
  }
  // This proves RouteManifest graphVersion canonicalization does not depend on
  // locale-sensitive sorting. Keep the patched window scoped to graph building.
  Object.defineProperty(String.prototype, "localeCompare", {
    configurable: true,
    value(this: string, compareString: string) {
      return Reflect.apply(originalLocaleCompare, compareString, [this]);
    },
  });

  try {
    return await run();
  } finally {
    Object.defineProperty(String.prototype, "localeCompare", {
      configurable: true,
      value: originalLocaleCompare,
    });
  }
}

async function createSemanticIdsFixture(appDir: string): Promise<void> {
  await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
  await writeAppFile(appDir, "(marketing)/layout.tsx", EMPTY_LAYOUT);
  await writeAppFile(appDir, "(marketing)/blog/[slug]/layout.tsx", EMPTY_LAYOUT);
  await writeAppFile(appDir, "(marketing)/blog/[slug]/template.tsx", EMPTY_LAYOUT);
  await writeAppFile(appDir, "(marketing)/blog/[slug]/page.tsx", EMPTY_PAGE);
  await writeAppFile(appDir, "(marketing)/blog/[slug]/@modal/default.tsx", EMPTY_PAGE);
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

  // Guards the scan-scoped fs-probe cache (issue #1912): sibling routes share
  // ancestor layouts/boundaries, and a missing root-level convention (the
  // not-found probe at app/) is memoized as `null`. Every route must still
  // resolve the same shared ancestor files and the same nearest boundary —
  // proving the cache returns identical results, including the null-miss path.
  it("resolves shared ancestors and nearest boundaries for sibling routes (probe cache)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/layout.tsx", EMPTY_LAYOUT);
      // not-found lives at the shared dashboard ancestor; app/not-found is absent
      // (its probe is memoized as null and must stay null for every descendant).
      await writeAppFile(appDir, "dashboard/not-found.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/reports/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/reports/details/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/settings/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      const sharedLayouts = [
        path.join(appDir, "layout.tsx"),
        path.join(appDir, "dashboard/layout.tsx"),
      ];
      const nearestNotFound = path.join(appDir, "dashboard/not-found.tsx");

      for (const pattern of [
        "/dashboard/reports",
        "/dashboard/reports/details",
        "/dashboard/settings",
      ]) {
        const route = findRoute(graph.routes, pattern);
        // Shared ancestor layouts resolve identically for every sibling.
        expect(route.layouts).toEqual(sharedLayouts);
        // Nearest not-found walks up to the shared dashboard boundary.
        expect(route.notFoundPath).toBe(nearestNotFound);
      }
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
        childrenRouteSegments: ["dashboard"],
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

  // Regression for https://github.com/cloudflare/vinext/issues/1339
  // Ported from Next.js: test/e2e/app-dir/parallel-routes-layouts/
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-layouts/parallel-routes-layouts.test.ts
  //
  // When a slot owns both a matched page and a default.tsx, the matched page
  // must win — vinext previously fell back to default.tsx ("default page"
  // instead of "Hello from Nested"). This locks in page-over-default priority
  // for the children slot and for sibling @foo/@bar slots simultaneously.
  it("prefers a matched slot page over default.tsx across sibling slots (issue #1339)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@global/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "nested/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@foo/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "nested/@foo/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@foo/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@bar/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "nested/@bar/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@bar/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@bar/subroute/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/@bar/modal/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "nested/settings/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      // At /nested the children slot must render nested/page.tsx, not the
      // sibling nested/default.tsx fallback.
      const nested = findRoute(graph.routes, "/nested");
      expect(nested.pagePath).toBe(path.join(appDir, "nested/page.tsx"));
      expect(nested.childrenSlot).toEqual({
        id: "slot:children:/nested",
        ownerTreePath: "/nested",
        state: "active",
      });
      expect(nested.parallelSlots.some((slot) => slot.ownerTreePath === "/")).toBe(true);

      // Each sibling slot has its own page AND its own default — the page wins.
      const foo = nested.parallelSlots.find((slot) => slot.name === "foo");
      const bar = nested.parallelSlots.find((slot) => slot.name === "bar");
      expect(foo).toMatchObject({
        name: "foo",
        pagePath: path.join(appDir, "nested/@foo/page.tsx"),
        defaultPath: path.join(appDir, "nested/@foo/default.tsx"),
        routeSegments: [],
      });
      expect(bar).toMatchObject({
        name: "bar",
        pagePath: path.join(appDir, "nested/@bar/page.tsx"),
        defaultPath: path.join(appDir, "nested/@bar/default.tsx"),
        routeSegments: [],
      });

      // /nested/subroute only has a match for the @bar slot. The children slot
      // falls back to nested/default.tsx, @bar mirrors its subroute page, and
      // @foo (no subroute page) keeps its default fallback.
      const subroute = findRoute(graph.routes, "/nested/subroute");
      expect(subroute.pagePath).toBe(path.join(appDir, "nested/default.tsx"));
      expect(subroute.childrenSlot).toEqual({
        id: "slot:children:/nested",
        ownerTreePath: "/nested",
        state: "default",
      });
      const subBar = subroute.parallelSlots.find((slot) => slot.name === "bar");
      const subFoo = subroute.parallelSlots.find((slot) => slot.name === "foo");
      expect(subBar).toMatchObject({
        name: "bar",
        pagePath: path.join(appDir, "nested/@bar/subroute/page.tsx"),
        routeSegments: ["subroute"],
      });
      expect(subFoo).toMatchObject({
        name: "foo",
        pagePath: null,
        defaultPath: path.join(appDir, "nested/@foo/default.tsx"),
      });

      expect(
        graph.routeManifest.segmentGraph.slotBindings.get("route:/nested::slot:children:/nested"),
      ).toMatchObject({
        ownerLayoutId: "layout:/nested",
        slotId: "slot:children:/nested",
        state: "active",
      });
      expect(
        graph.routeManifest.segmentGraph.slotBindings.get(
          "route:/nested/subroute::slot:children:/nested",
        ),
      ).toMatchObject({
        ownerLayoutId: "layout:/nested",
        slotId: "slot:children:/nested",
        state: "default",
      });

      const settings = findRoute(graph.routes, "/nested/settings");
      expect(settings.pagePath).toBe(path.join(appDir, "nested/settings/page.tsx"));
      expect(settings.childrenSlot).toEqual({
        id: "slot:children:/nested",
        ownerTreePath: "/nested",
        state: "active",
      });
      expect(
        graph.routeManifest.segmentGraph.slotBindings.get(
          "route:/nested/settings::slot:children:/nested",
        ),
      ).toMatchObject({
        ownerLayoutId: "layout:/nested",
        slotId: "slot:children:/nested",
        state: "active",
      });

      const modal = findRoute(graph.routes, "/nested/modal");
      expect(modal.pagePath).toBe(path.join(appDir, "nested/default.tsx"));
      expect(modal.childrenSlot).toEqual({
        id: "slot:children:/nested",
        ownerTreePath: "/nested",
        state: "default",
      });
    });
  });

  it("prefers the nearest implicit children owner for nested parallel-route families", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@analytics/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@analytics/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/@analytics/sub/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/team/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/team/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/team/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/team/@members/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/team/@members/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "dashboard/team/@members/sub/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

      const team = findRoute(graph.routes, "/dashboard/team");
      expect(team.childrenSlot).toEqual({
        id: "slot:children:/dashboard/team",
        ownerTreePath: "/dashboard/team",
        state: "active",
      });

      const teamSubroute = findRoute(graph.routes, "/dashboard/team/sub");
      expect(teamSubroute.childrenSlot).toEqual({
        id: "slot:children:/dashboard/team",
        ownerTreePath: "/dashboard/team",
        state: "default",
      });
      expect(
        graph.routeManifest.segmentGraph.slotBindings.get(
          "route:/dashboard/team::slot:children:/dashboard/team",
        ),
      ).toMatchObject({
        ownerLayoutId: "layout:/dashboard/team",
        state: "active",
      });
    });
  });

  it("materializes synthetic routes from a sibling route-group's parallel slot", async () => {
    // Two sibling route groups share the same URL pattern at the root:
    //   (group-a) provides a layout-only route with a catch-all parallel slot
    //   (group-b) provides the children page at the same URL pattern
    // The (group-a) layout cannot become a route on its own (collision), but
    // its slot's nested catch-all page must still materialize a synthetic
    // route so that URLs not matched by (group-b) fall through to the slot.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "(group-a)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(group-a)/@parallel/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(group-a)/@parallel/[...catcher]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(group-b)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(group-b)/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(group-b)/foo/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern).sort();
      // Real page routes from (group-b)
      expect(patterns).toContain("/");
      expect(patterns).toContain("/foo");
      // Synthetic catch-all from (group-a)'s @parallel slot
      expect(patterns).toContain("/:catcher+");

      const catcher = findRoute(graph.routes, "/:catcher+");
      // The layout-only ghost parent is not added to routes, but the synthetic
      // sub-route inherits (group-a)'s layout chain.
      expect(catcher.layouts).toEqual([path.join(appDir, "(group-a)/layout.tsx")]);
      expect(catcher.parallelSlots).toHaveLength(1);
      expect(catcher.parallelSlots[0]).toMatchObject({
        name: "parallel",
        pagePath: path.join(appDir, "(group-a)/@parallel/[...catcher]/page.tsx"),
        routeSegments: ["[...catcher]"],
      });

      // The real /foo route belongs to (group-b) only — it must not pick up
      // slots from the sibling group.
      const foo = findRoute(graph.routes, "/foo");
      expect(foo.parallelSlots).toHaveLength(0);
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

  // Regression for https://github.com/cloudflare/vinext/issues/1535
  // Ported from Next.js: test/e2e/app-dir/parallel-routes-catchall-children-slot/
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/parallel-routes-catchall-children-slot/parallel-routes-catchall-children-slot.test.ts
  describe("@children slot priority (issue #1535)", () => {
    it("uses @children/page.tsx as the page for '/' over a sibling [...catchAll]", async () => {
      // app/@children/page.tsx provides the layout's `children` prop at '/'.
      // app/[...catchAll]/page.tsx is a catch-all that should NOT win for '/'.
      // Next.js parity: see normalize-catchall-routes.ts (@children is not
      // a "matchable slot" so the catchall does not displace it).
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "@children/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((r) => r.pattern).sort();

        // The root URL must resolve as a real page, sourced from @children/page.tsx.
        expect(patterns).toContain("/");
        const root = findRoute(graph.routes, "/");
        expect(root.pagePath).toBe(path.join(appDir, "@children/page.tsx"));

        // The catch-all must still cover deeper paths.
        expect(patterns).toContain("/:catchAll+");

        // The @slot slot is attached to '/', not consumed as a top-level route.
        const slotNames = root.parallelSlots.map((s) => s.name).sort();
        expect(slotNames).toContain("slot");
      });
    });

    it("resolves '/nested' to @children/page when only the @children slot exists (no default)", async () => {
      // The nested directory has a layout and a @children slot with a page,
      // but no default.tsx for the children slot. The route '/nested' must
      // still materialize and the page must come from @children/page.tsx.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "@slot/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "nested/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "nested/@children/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((r) => r.pattern).sort();

        expect(patterns).toContain("/nested");
        const nested = findRoute(graph.routes, "/nested");
        expect(nested.pagePath).toBe(path.join(appDir, "nested/@children/page.tsx"));
      });
    });
  });

  // Regression for https://github.com/cloudflare/vinext/issues/1535
  // Ported from Next.js: test/e2e/app-dir/parallel-routes-catchall/
  // ("should match correctly when defining an explicit slot but no page").
  describe("explicit slot but no page (issue #1535)", () => {
    // Ported from Next.js:
    // test/e2e/app-dir/parallel-routes-leaf-segments/fixtures/no-build-error/app/no-children
    // https://github.com/vercel/next.js/tree/v16.2.6/test/e2e/app-dir/parallel-routes-leaf-segments/fixtures/no-build-error/app/no-children
    it("uses the parent children default for a leaf parallel-slot sub-route", async () => {
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "no-children/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "no-children/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "no-children/@slot/other/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const route = findRoute(graph.routes, "/no-children/other");

        expect(route.pagePath).toBe(path.join(appDir, "no-children/default.tsx"));
        expect(route.parallelSlots.find((slot) => slot.name === "slot")?.pagePath).toBe(
          path.join(appDir, "no-children/@slot/other/page.tsx"),
        );
      });
    });

    it("falls children through to the sibling catch-all for a slot-only sub-route", async () => {
      // /baz: @slot/baz/page.tsx exists, but there is no baz/page.tsx and no
      // root default.tsx. Next.js serves /baz's children from the sibling
      // [...catchAll]/page.tsx ("main catchall") while the @slot slot renders
      // @slot/baz/page.tsx ("baz slot"). Without the catch-all children
      // fallback the synthetic /baz route shadows the catch-all with an empty
      // children prop and the request hangs.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/baz/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "@slot/foo/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/baz/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/[...catchAll]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "bar/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((r) => r.pattern).sort();

        // The slot-only sub-route must materialise so @slot/baz wins over the
        // slot's own catch-all.
        expect(patterns).toContain("/baz");
        const baz = findRoute(graph.routes, "/baz");

        // Children fall through to the sibling catch-all (not null → no hang).
        expect(baz.pagePath).toBe(path.join(appDir, "[...catchAll]/page.tsx"));

        // The @slot slot resolves to the explicit @slot/baz page, not the
        // slot's catch-all.
        const slot = baz.parallelSlots.find((s) => s.name === "slot");
        expect(slot?.pagePath).toBe(path.join(appDir, "@slot/baz/page.tsx"));
        expect(slot?.configLayoutPaths).toEqual([path.join(appDir, "@slot/baz/layout.tsx")]);

        // The top-level catch-all is still present for fully-unmatched paths.
        expect(patterns).toContain("/:catchAll+");
      });
    });

    it("builds the slot-only catch-all sub-route with a static pattern (documents params limitation)", async () => {
      // The synthetic /baz route's URL pattern is static, so its catch-all
      // children page receives empty params at render time (Next.js would pass
      // params.catchAll = ["baz"]). Lock in the current shape so a future fix
      // that populates the catch-all param has to update this assertion. See
      // the "Known limitation" note in discoverSlotSubRoutes.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/baz/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const baz = findRoute(graph.routes, "/baz");

        expect(baz.pagePath).toBe(path.join(appDir, "[...catchAll]/page.tsx"));
        // Static pattern → no catch-all param captured for the children page.
        expect(baz.isDynamic).toBe(false);
        expect(baz.params).toEqual([]);
        expect(baz.patternParts).toEqual(["baz"]);
      });
    });

    it("prefers a children default.tsx over the catch-all when both exist", async () => {
      // When the parent provides a default.tsx for the children slot, it wins
      // over a sibling catch-all (default.tsx is the canonical children
      // fallback). This guards the new catch-all fallback from displacing it.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/baz/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const baz = findRoute(graph.routes, "/baz");
        expect(baz.pagePath).toBe(path.join(appDir, "default.tsx"));
      });
    });
  });

  // Ported from Next.js: test/e2e/app-dir/catchall-parallel-routes-group/
  it("discovers a parallel slot page inside a route group (catchall-parallel-routes-group)", async () => {
    // Fixture mirrors the e2e test:
    //   app/[...catchAll]/layout.tsx  — layout with `slot` prop
    //   app/[...catchAll]/page.tsx    — children page
    //   app/[...catchAll]/@slot/layout.tsx
    //   app/[...catchAll]/@slot/(group)/page.tsx  ← page inside route group
    //
    // The slot has NO direct page.tsx at the @slot root; the page lives inside
    // a transparent route-group directory. discoverParallelSlots must still
    // find and include the slot so it renders correctly.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[...catchAll]/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[...catchAll]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[...catchAll]/@slot/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[...catchAll]/@slot/(group)/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const catchAll = findRoute(graph.routes, "/:catchAll+");

      // The slot must be present and resolve to the page inside the route group.
      expect(catchAll.parallelSlots).toHaveLength(1);
      expect(catchAll.parallelSlots[0]).toMatchObject({
        name: "slot",
        pagePath: path.join(appDir, "[...catchAll]/@slot/(group)/page.tsx"),
        hasPage: true,
        // The route group is transparent in the URL, so routeSegments is empty.
        routeSegments: [],
      });
    });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-catchall-default/parallel-routes-catchall-default.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-catchall-default/parallel-routes-catchall-default.test.ts
  it("matches nested parallel slot pages before an ancestor optional catch-all", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/[[...catchAll]]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/@slot/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/@slot/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/@slot/[baz]/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/nested/[foo]/[bar]/@slot/[baz]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const nested = findRoute(graph.routes, "/:locale/nested/:foo/:bar");
      const nestedBaz = findRoute(graph.routes, "/:locale/nested/:foo/:bar/:baz");

      expect(nested.pagePath).toBe(path.join(appDir, "[locale]/nested/[foo]/[bar]/default.tsx"));
      expect(nested.parallelSlots.find((slot) => slot.name === "slot")?.pagePath).toBe(
        path.join(appDir, "[locale]/nested/[foo]/[bar]/@slot/page.tsx"),
      );
      expect(nestedBaz.pagePath).toBe(path.join(appDir, "[locale]/nested/[foo]/[bar]/default.tsx"));
      expect(nestedBaz.parallelSlots.find((slot) => slot.name === "slot")?.pagePath).toBe(
        path.join(appDir, "[locale]/nested/[foo]/[bar]/@slot/[baz]/page.tsx"),
      );
    });
  });

  // Ported from Next.js:
  // test/e2e/app-dir/parallel-routes-catchall-slotted-non-catchalls/parallel-routes-catchall-slotted-non-catchalls.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-catchall-slotted-non-catchalls/parallel-routes-catchall-slotted-non-catchalls.test.ts
  it("lets an optional catch-all supply children for a layout-only slot owner", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[locale]/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/@slot/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/@slot/other/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[locale]/[[...catchAll]]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const localeCatchAll = findRoute(graph.routes, "/:locale/:catchAll*");

      expect(graph.routes.some((route) => route.pattern === "/:locale")).toBe(false);
      expect(localeCatchAll.parallelSlots.find((slot) => slot.name === "slot")).toMatchObject({
        pagePath: null,
        defaultPath: path.join(appDir, "[locale]/@slot/default.tsx"),
      });
    });
  });

  it("keeps a standalone layout-only slot owner as a route", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "parallel-nested/home/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "parallel-nested/home/@parallel/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "parallel-nested/home/@parallel/nested/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const parent = findRoute(graph.routes, "/parallel-nested/home");
      const nested = findRoute(graph.routes, "/parallel-nested/home/nested");

      expect(parent.pagePath).toBeNull();
      expect(parent.parallelSlots.find((slot) => slot.name === "parallel")?.defaultPath).toBe(
        path.join(appDir, "parallel-nested/home/@parallel/default.tsx"),
      );
      expect(nested.parallelSlots.find((slot) => slot.name === "parallel")?.pagePath).toBe(
        path.join(appDir, "parallel-nested/home/@parallel/nested/page.tsx"),
      );
    });
  });

  // Ported from Next.js: test/e2e/app-dir/parallel-routes-group-depth/parallel-routes-group-depth.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/parallel-routes-group-depth/parallel-routes-group-depth.test.ts
  it("keeps a sibling slot active when children are inside a route group", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "group-depth/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "group-depth/(children)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "group-depth/(children)/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "group-depth/@slot/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "group-depth/@slot/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const route = findRoute(graph.routes, "/group-depth");
      const slot = route.parallelSlots.find((candidate) => candidate.name === "slot");

      expect(route.pagePath).toBe(path.join(appDir, "group-depth/(children)/page.tsx"));
      expect(slot).toMatchObject({
        pagePath: path.join(appDir, "group-depth/@slot/page.tsx"),
        layoutPath: path.join(appDir, "group-depth/@slot/layout.tsx"),
        routeSegments: [],
      });
    });
  });

  it("records nested active slot layouts for segment config reduction", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@slot/dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "@slot/dashboard/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const route = findRoute(graph.routes, "/dashboard");
      const slot = route.parallelSlots.find((candidate) => candidate.name === "slot");

      expect(slot).toMatchObject({
        pagePath: path.join(appDir, "@slot/dashboard/page.tsx"),
        configLayoutPaths: [path.join(appDir, "@slot/dashboard/layout.tsx")],
        configLayoutTreePositions: [1],
      });
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

  it("discovers error boundaries in route groups without sibling layouts", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(
        appDir,
        "docs/(group)/error.tsx",
        "export default function Error() { return null; }\n",
      );
      await writeAppFile(appDir, "docs/(group)/child/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher(["tsx"]));
      const route = findRoute(graph.routes, "/docs/child");

      expect(route.layoutTreePositions).toEqual([0]);
      expect(route.layoutErrorPaths).toEqual([null]);
      expect(route.errorPaths).toEqual([path.join(appDir, "docs/(group)/error.tsx")]);
      expect(route.errorTreePositions).toEqual([2]);
    });
  });

  it("mints semantic ids for routes, entries, layouts, templates, and slots", async () => {
    await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const graphRoutes: readonly AppRouteGraphRoute[] = graph.routes;
      const route = findRoute(graph.routes, "/blog/:slug");

      expect(graphRoutes).toHaveLength(1);
      expect(route.ids).toEqual({
        route: "route:/blog/:slug",
        page: "page:/blog/:slug",
        routeHandler: null,
        rootBoundary: "root-boundary:/",
        layouts: ["layout:/", "layout:/(marketing)", "layout:/(marketing)/blog/[slug]"],
        templates: ["template:/(marketing)/blog/[slug]"],
        slots: {
          "modal@(marketing)/blog/[slug]/@modal": "slot:modal:/(marketing)/blog/[slug]",
        },
      });
      expect(route.parallelSlots[0]).toMatchObject({
        id: "slot:modal:/(marketing)/blog/[slug]",
        key: "modal@(marketing)/blog/[slug]/@modal",
      });
    });
  });

  it("materializes slot-local layouts in the static segment graph", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@modal/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "@modal/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const { segmentGraph } = graph.routeManifest;

      expect(segmentGraph.layouts.get("layout:/@modal")).toEqual({
        id: "layout:/@modal",
        treePath: "/@modal",
        patternParts: [],
        paramNames: [],
        rootBoundaryId: "root-boundary:/",
      });
    });
  });

  it("exposes a minimal RouteManifest read model keyed by semantic ids", async () => {
    await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);
      await writeAppFile(appDir, "(marketing)/api/route.ts", EMPTY_ROUTE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const manifest = graph.routeManifest;
      const segmentGraph = manifest.segmentGraph;

      expect(manifest.graphVersion).toMatch(/^graph:[a-f0-9]{64}$/);
      expect(segmentGraph.routes.get("route:/blog/:slug")).toEqual({
        id: "route:/blog/:slug",
        pattern: "/blog/:slug",
        patternParts: ["blog", ":slug"],
        isDynamic: true,
        paramNames: ["slug"],
        rootParamNames: [],
        rootBoundaryId: "root-boundary:/",
        pageId: "page:/blog/:slug",
        routeHandlerId: null,
        layoutIds: ["layout:/", "layout:/(marketing)", "layout:/(marketing)/blog/[slug]"],
        templateIds: ["template:/(marketing)/blog/[slug]"],
        slotIds: ["slot:modal:/(marketing)/blog/[slug]"],
      });
      expect(segmentGraph.routes.get("route:/api")).toEqual({
        id: "route:/api",
        pattern: "/api",
        patternParts: ["api"],
        isDynamic: false,
        paramNames: [],
        rootParamNames: [],
        rootBoundaryId: "root-boundary:/",
        pageId: null,
        routeHandlerId: "route-handler:/api",
        layoutIds: ["layout:/", "layout:/(marketing)"],
        templateIds: [],
        slotIds: [],
      });
      expect(segmentGraph.pages.get("page:/blog/:slug")).toEqual({
        id: "page:/blog/:slug",
        routeId: "route:/blog/:slug",
        pattern: "/blog/:slug",
      });
      expect(segmentGraph.routeHandlers.get("route-handler:/api")).toEqual({
        id: "route-handler:/api",
        routeId: "route:/api",
        pattern: "/api",
      });
      expect(segmentGraph.layouts.get("layout:/(marketing)/blog/[slug]")).toEqual({
        id: "layout:/(marketing)/blog/[slug]",
        treePath: "/(marketing)/blog/[slug]",
        patternParts: ["blog", ":slug"],
        paramNames: ["slug"],
        rootBoundaryId: "root-boundary:/",
      });
      expect(segmentGraph.templates.get("template:/(marketing)/blog/[slug]")).toEqual({
        id: "template:/(marketing)/blog/[slug]",
        treePath: "/(marketing)/blog/[slug]",
        rootBoundaryId: "root-boundary:/",
        ownerLayoutId: "layout:/(marketing)/blog/[slug]",
        reset: {
          kind: "remountSubtree",
          treePath: "/(marketing)/blog/[slug]",
        },
      });
      expect(segmentGraph.slots.get("slot:modal:/(marketing)/blog/[slug]")).toEqual({
        id: "slot:modal:/(marketing)/blog/[slug]",
        key: "modal@(marketing)/blog/[slug]/@modal",
        name: "modal",
        ownerTreePath: "/(marketing)/blog/[slug]",
        ownerLayoutId: "layout:/(marketing)/blog/[slug]",
        rootBoundaryId: "root-boundary:/",
        defaultId: "default:slot:modal:/(marketing)/blog/[slug]",
        hasDefault: true,
        hasPage: false,
      });
      expect(segmentGraph.defaults.get("default:slot:modal:/(marketing)/blog/[slug]")).toEqual({
        id: "default:slot:modal:/(marketing)/blog/[slug]",
        slotId: "slot:modal:/(marketing)/blog/[slug]",
        ownerLayoutId: "layout:/(marketing)/blog/[slug]",
        ownerTreePath: "/(marketing)/blog/[slug]",
        rootBoundaryId: "root-boundary:/",
      });
      expect(segmentGraph.rootBoundaries.get("root-boundary:/")).toEqual({
        id: "root-boundary:/",
        layoutId: "layout:/",
        treePath: "/",
      });
    });
  });

  it("mints distinct root boundary ids for route-group root layouts", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "(marketing)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/marketing/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(shop)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(shop)/shop/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const rootBoundaryIds = graph.routes
        .map((route) => route.ids.rootBoundary)
        .sort((left, right) => {
          const leftKey = String(left);
          const rightKey = String(right);
          if (leftKey < rightKey) return -1;
          if (leftKey > rightKey) return 1;
          return 0;
        });

      expect(rootBoundaryIds).toEqual(["root-boundary:/(marketing)", "root-boundary:/(shop)"]);
      expect(Array.from(graph.routeManifest.segmentGraph.rootBoundaries.keys()).sort()).toEqual([
        "root-boundary:/(marketing)",
        "root-boundary:/(shop)",
      ]);
    });
  });

  it("uses null rootBoundaryId when a route has no layout boundary", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layoutless/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const route = findRoute(graph.routes, "/layoutless");

      expect(route.ids.rootBoundary).toBeNull();
      expect(graph.routeManifest.segmentGraph.routes.get("route:/layoutless")).toMatchObject({
        id: "route:/layoutless",
        rootBoundaryId: null,
        layoutIds: [],
      });
      expect(graph.routeManifest.segmentGraph.rootBoundaries.size).toBe(0);
    });
  });

  it("exposes RouteManifest facts for route groups, slots, templates, and boundaries", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "(marketing)/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/template.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/error.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/not-found.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/dashboard/template.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "(marketing)/dashboard/forbidden.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/unauthorized.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/@analytics/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/@modal/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/@modal/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "(marketing)/dashboard/@modal/settings/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const segmentGraph = graph.routeManifest.segmentGraph;

      expect(segmentGraph.slots.get("slot:analytics:/(marketing)/dashboard")).toEqual({
        id: "slot:analytics:/(marketing)/dashboard",
        key: "analytics@(marketing)/dashboard/@analytics",
        name: "analytics",
        ownerTreePath: "/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
        defaultId: "default:slot:analytics:/(marketing)/dashboard",
        hasDefault: true,
        hasPage: false,
      });
      expect(segmentGraph.slots.get("slot:modal:/(marketing)/dashboard")).toMatchObject({
        ownerTreePath: "/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
        defaultId: "default:slot:modal:/(marketing)/dashboard",
        hasDefault: true,
        hasPage: true,
      });
      expect(segmentGraph.defaults.get("default:slot:analytics:/(marketing)/dashboard")).toEqual({
        id: "default:slot:analytics:/(marketing)/dashboard",
        slotId: "slot:analytics:/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        ownerTreePath: "/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
      });

      expect(
        segmentGraph.slotBindings.get("route:/dashboard::slot:analytics:/(marketing)/dashboard"),
      ).toEqual({
        id: "route:/dashboard::slot:analytics:/(marketing)/dashboard",
        routeId: "route:/dashboard",
        slotId: "slot:analytics:/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        state: "default",
        defaultId: "default:slot:analytics:/(marketing)/dashboard",
        routeSegments: null,
      });
      expect(
        segmentGraph.slotBindings.get("route:/dashboard::slot:modal:/(marketing)/dashboard"),
      ).toEqual({
        id: "route:/dashboard::slot:modal:/(marketing)/dashboard",
        routeId: "route:/dashboard",
        slotId: "slot:modal:/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        state: "active",
        defaultId: null,
        routeSegments: [],
      });
      expect(
        segmentGraph.slotBindings.get(
          "route:/dashboard/settings::slot:modal:/(marketing)/dashboard",
        ),
      ).toEqual({
        id: "route:/dashboard/settings::slot:modal:/(marketing)/dashboard",
        routeId: "route:/dashboard/settings",
        slotId: "slot:modal:/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        state: "active",
        defaultId: null,
        routeSegments: ["settings"],
      });

      expect(segmentGraph.templates.get("template:/(marketing)")).toEqual({
        id: "template:/(marketing)",
        treePath: "/(marketing)",
        rootBoundaryId: "root-boundary:/(marketing)",
        ownerLayoutId: "layout:/(marketing)",
        reset: {
          kind: "remountSubtree",
          treePath: "/(marketing)",
        },
      });
      expect(segmentGraph.templates.get("template:/(marketing)/dashboard")).toEqual({
        id: "template:/(marketing)/dashboard",
        treePath: "/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        reset: {
          kind: "remountSubtree",
          treePath: "/(marketing)/dashboard",
        },
      });

      expect(segmentGraph.boundaries.get("boundary:error:/(marketing)")).toEqual({
        id: "boundary:error:/(marketing)",
        outcome: "error",
        treePath: "/(marketing)",
        ownerLayoutId: "layout:/(marketing)",
        rootBoundaryId: "root-boundary:/(marketing)",
      });
      expect(segmentGraph.boundaries.get("boundary:notFound:/(marketing)")).toEqual({
        id: "boundary:notFound:/(marketing)",
        outcome: "notFound",
        treePath: "/(marketing)",
        ownerLayoutId: "layout:/(marketing)",
        rootBoundaryId: "root-boundary:/(marketing)",
      });
      expect(segmentGraph.boundaries.get("boundary:forbidden:/(marketing)/dashboard")).toEqual({
        id: "boundary:forbidden:/(marketing)/dashboard",
        outcome: "forbidden",
        treePath: "/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
      });
      expect(segmentGraph.boundaries.get("boundary:unauthorized:/(marketing)/dashboard")).toEqual({
        id: "boundary:unauthorized:/(marketing)/dashboard",
        outcome: "unauthorized",
        treePath: "/(marketing)/dashboard",
        ownerLayoutId: "layout:/(marketing)/dashboard",
        rootBoundaryId: "root-boundary:/(marketing)",
      });
    });
  });

  it("exposes segment error boundary facts even when the segment has no sibling layout", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "docs/(group)/error.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "docs/(group)/child/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const boundary = graph.routeManifest.segmentGraph.boundaries.get(
        "boundary:error:/docs/(group)",
      );

      expect(boundary).toEqual({
        id: "boundary:error:/docs/(group)",
        outcome: "error",
        treePath: "/docs/(group)",
        ownerLayoutId: null,
        rootBoundaryId: "root-boundary:/",
      });
      expect(graph.routeManifest.segmentGraph.boundaries.has("boundary:error:/docs")).toBe(false);
    });
  });

  it("keeps semantic ids stable across different filesystem roots", async () => {
    const firstIds = await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);
      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      return findRoute(graph.routes, "/blog/:slug").ids;
    });

    const secondIds = await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);
      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      return findRoute(graph.routes, "/blog/:slug").ids;
    });

    expect(firstIds).toBeDefined();
    expect(secondIds).toEqual(firstIds);
  });

  it("keeps RouteManifest graph output stable across different filesystem roots", async () => {
    const firstManifest = await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);
      await writeAppFile(appDir, "(marketing)/api/route.ts", EMPTY_ROUTE);
      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      return snapshotRouteManifest(graph.routeManifest);
    });

    const secondManifest = await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);
      await writeAppFile(appDir, "(marketing)/api/route.ts", EMPTY_ROUTE);
      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      return snapshotRouteManifest(graph.routeManifest);
    });

    expect(secondManifest).toEqual(firstManifest);
  });

  it("does not let locale collation affect RouteManifest graphVersion", async () => {
    const graphVersions = await withTempApp(async (appDir) => {
      await createSemanticIdsFixture(appDir);

      const normalGraph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const reverseLocaleGraph = await withReverseLocaleCompare(() =>
        buildAppRouteGraph(appDir, createValidFileMatcher()),
      );

      return [
        normalGraph.routeManifest.graphVersion,
        reverseLocaleGraph.routeManifest.graphVersion,
      ];
    });

    expect(graphVersions[1]).toBe(graphVersions[0]);
  });

  it("links inherited parallel slot to a mirrored sub-page (literal segments)", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "about/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "@breadcrumbs/about/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "@breadcrumbs/about/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const about = findRoute(graph.routes, "/about");
      expect(about.parallelSlots).toHaveLength(1);
      expect(about.parallelSlots[0]).toMatchObject({
        name: "breadcrumbs",
        pagePath: path.join(appDir, "@breadcrumbs/about/page.tsx"),
        defaultPath: path.join(appDir, "@breadcrumbs/default.tsx"),
        configLayoutPaths: [path.join(appDir, "@breadcrumbs/about/layout.tsx")],
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

  it("captures catch-all slotPatternParts for inherited parallel routes", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[teamID]/layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[teamID]/sub/folder/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[teamID]/@slot/default.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[teamID]/@slot/[...catchAll]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const route = findRoute(graph.routes, "/:teamID/sub/folder");
      expect(route.parallelSlots[0]).toMatchObject({
        name: "slot",
        pagePath: path.join(appDir, "[teamID]/@slot/[...catchAll]/page.tsx"),
        routeSegments: ["[...catchAll]"],
        slotPatternParts: [":teamID", ":catchAll+"],
        slotParamNames: ["teamID", "catchAll"],
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

  it("accepts dynamic segment names with dots and at-signs (Next.js parity)", async () => {
    // Next.js PARAMETER_PATTERN accepts any non-] characters inside brackets.
    // See: https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/get-dynamic-param.ts
    // Note: colon (:) is tested via patternToNextFormat in route-sorting.test.ts
    // to avoid NTFS filename issues on Windows.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "products/[variant.id]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "users/[user@domain]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern);

      expect(patterns).toContain("/products/:variant.id");
      expect(patterns).toContain("/users/:user@domain");
    });
  });

  it("accepts catch-all and optional-catch-all segments with broadened param names", async () => {
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[...variant.id]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "blog/[[...user@domain]]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern);

      expect(patterns).toContain("/:variant.id+");
      expect(patterns).toContain("/blog/:user@domain*");
    });
  });

  it("skips routes whose param names end in + or * (would collide with internal modifiers)", async () => {
    // Param names ending in + or * would map to :id+ / :id*, which the trie
    // matcher interprets as catch-all / optional-catch-all. Skip these routes
    // entirely to avoid ambiguity.
    await withTempApp(async (appDir) => {
      await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
      await writeAppFile(appDir, "[id+]/page.tsx", EMPTY_PAGE);
      await writeAppFile(appDir, "[id*]/page.tsx", EMPTY_PAGE);

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const patterns = graph.routes.map((r) => r.pattern);

      expect(patterns).not.toContain("/:id+");
      expect(patterns).not.toContain("/:id*");
      expect(patterns).toHaveLength(0);
    });
  });

  // Intercepting route source-pattern computation. Mirrors Next.js'
  // `extractInterceptionRouteInformation` which derives the intercepting
  // route from the slot's owner path (route groups + `@slot` segments are
  // invisible). The pattern is used at request time to gate `findIntercept`
  // against the Next-URL header.
  // https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/interception-routes.ts
  describe("intercepting routes", () => {
    function collectIntercepts(routes: readonly AppRouteGraphRoute[]) {
      const out: Array<{
        ownerRoute: string;
        slotKey: string;
        targetPattern: string;
        sourceMatchPattern: string;
        sourcePageSegments?: string[];
        layoutSegments?: string[][];
        branchSegments?: string[];
        convention: string;
        params: string[];
      }> = [];
      for (const route of routes) {
        for (const slot of route.parallelSlots) {
          for (const ir of slot.interceptingRoutes) {
            out.push({
              ownerRoute: route.pattern,
              slotKey: slot.key,
              targetPattern: ir.targetPattern,
              sourceMatchPattern: ir.sourceMatchPattern,
              sourcePageSegments: ir.sourcePageSegments,
              layoutSegments: ir.layoutSegments,
              branchSegments: ir.branchSegments,
              convention: ir.convention,
              params: ir.params,
            });
          }
        }
      }
      return out;
    }

    function collectSiblingIntercepts(routes: readonly AppRouteGraphRoute[]) {
      const out: Array<{
        ownerRoute: string;
        targetPattern: string;
        sourceMatchPattern: string;
        sourcePageSegments?: string[];
        layoutSegments?: string[][];
        branchSegments?: string[];
        convention: string;
        params: string[];
      }> = [];
      for (const route of routes) {
        for (const ir of (route as any).siblingIntercepts ?? []) {
          out.push({
            ownerRoute: route.pattern,
            targetPattern: ir.targetPattern,
            sourceMatchPattern: ir.sourceMatchPattern,
            sourcePageSegments: ir.sourcePageSegments,
            layoutSegments: ir.layoutSegments,
            branchSegments: ir.branchSegments,
            convention: ir.convention,
            params: ir.params,
          });
        }
      }
      return out;
    }

    it("computes `/` for root-level (.) slot", async () => {
      // Mirrors test/e2e/app-dir/parallel-routes-and-interception-basepath.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "nested/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@slot/(.)nested/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/nested",
            sourceMatchPattern: "/",
            convention: ".",
          }),
        );
      });
    });

    it("computes target with subdirectory prefix for (.) slot nested in a slot subdirectory", async () => {
      // Regression test for issue #1364 Part A.
      // When the (.) marker lives inside a subdirectory of the @slot dir, baseParts
      // must include the visible segments between appDir and the marker's parent dir,
      // not just the routeDir-relative segments (which omit the subdirectory).
      //
      // Layout:
      //   app/@modal/sub/(.)target/[id]/page.tsx
      //   routeDir = app/ (root), but marker parent is app/@modal/sub
      //   expected targetPattern = /sub/target/:id  (not /:id)
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "sub/target/[id]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "@modal/sub/(.)target/[id]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        // sourceMatchPattern derives from interceptParentDir (app/@modal/sub),
        // stripping the invisible @modal → remaining visible segment "sub" → "/sub".
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/sub/target/:id",
            sourceMatchPattern: "/sub",
            convention: ".",
          }),
        );
      });
    });

    it("includes dynamic ancestor params for (.) slot with a dynamic ancestor segment", async () => {
      // Regression for the double-conversion bug: raw filesystem segments must be
      // passed as baseParts so that [locale] is not converted to :locale before
      // the final convertSegmentsToRouteParts call (which would then treat :locale
      // as static and drop it from params).
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/photos/[id]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/@modal/(.)photos/[id]/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/@modal/(.)photos/[id]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/:locale/photos/:id",
            params: ["locale", "id"],
            layoutSegments: [["photos", "[id]"]],
            branchSegments: ["photos", "[id]"],
            convention: ".",
          }),
        );
      });
    });

    it("computes `/feed` for (..) slot nested under a static segment", async () => {
      // Mirrors the (..) marker scoped to a parallel slot: source pathname
      // must match the slot's owner directory (`/feed`), and the target
      // pattern climbs one segment to `/photos/:id`.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "photos/[id]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "feed/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "feed/@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "feed/@modal/(..)photos/[id]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/photos/:id",
            sourceMatchPattern: "/feed",
            convention: "..",
          }),
        );
      });
    });

    it("strips `@modal` and keeps dynamic ancestor segments", async () => {
      // Mirrors test/e2e/app-dir/parallel-routes-and-interception-from-root:
      // app/[locale]/example/@modal/(...)[locale]/intercepted/page.tsx
      // intercepting route = /[locale]/example.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/example/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/example/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/example/@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(
          appDir,
          "[locale]/example/@modal/(...)[locale]/intercepted/page.tsx",
          EMPTY_PAGE,
        );

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/:locale/intercepted",
            sourceMatchPattern: "/:locale/example",
            convention: "...",
          }),
        );
      });
    });

    it("computes intercepting route across `(..)(..)` two-levels-up marker", async () => {
      // Inspired by test/e2e/app-dir/interception-segments-two-levels-above
      // but adapted to use a parallel slot, which is the structure vinext
      // currently supports for interception markers.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "hoge/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/@modal/(..)(..)hoge/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const intercepts = collectIntercepts(graph.routes);

        // (..)(..) target climbs two visible segments from /foo/bar → /,
        // then appends `hoge`. Intercepting route remains /foo/bar.
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/hoge",
            sourceMatchPattern: "/foo/bar",
            sourcePageSegments: ["foo", "bar", "@modal", "(..)(..)hoge"],
            convention: "../..",
          }),
        );
      });
    });

    it("promotes dynamic interception topology into RouteManifest facts", async () => {
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/feed/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "[locale]/feed/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/photos/[id]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/feed/@modal/default.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "[locale]/feed/@modal/(..)photos/[id]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const interceptions = Array.from(graph.routeManifest.segmentGraph.interceptions.values());
        const interceptionsBySlotId = Array.from(
          graph.routeManifest.segmentGraph.interceptionsBySlotId.entries(),
        );

        expect(interceptions).toEqual([
          {
            id: "interception:slot:modal:/[locale]/feed:/:locale/feed->/:locale/photos/:id",
            sourcePattern: "/:locale/feed",
            sourcePatternParts: [":locale", "feed"],
            targetPattern: "/:locale/photos/:id",
            targetPatternParts: [":locale", "photos", ":id"],
            slotId: "slot:modal:/[locale]/feed",
            ownerLayoutId: "layout:/[locale]/feed",
            interceptingRouteId: "route:/:locale/feed",
            targetRouteId: "route:/:locale/photos/:id",
          },
        ]);
        expect(interceptionsBySlotId).toEqual([["slot:modal:/[locale]/feed", interceptions]]);
      });
    });

    it("registers `(..)` sibling interception for showcase catchall outside a parallel slot", async () => {
      // Ported from Next.js: test/e2e/app-dir/interception-routes-multiple-catchall
      // The marker at templates/(..)showcase is a sibling (no @slot). Build must not
      // register it as a literal route, AND must register it as a sibling intercept.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "showcase/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "templates/layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "templates/[...catchAll]/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "templates/(..)showcase/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "templates/(..)showcase/[...catchAll]/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((route) => route.pattern);

        for (const pattern of patterns) {
          expect(pattern).not.toMatch(/\(\.{1,3}\)/);
        }

        const intercepts = collectSiblingIntercepts(graph.routes);
        // (..) from templates/ climbs 1 visible segment → target /showcase
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/showcase",
            sourceMatchPattern: "/templates",
            convention: "..",
          }),
        );
        // Also the catchAll page registers a sibling intercept for /showcase/:catchAll+
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/showcase/:catchAll+",
            sourceMatchPattern: "/templates",
            convention: "..",
          }),
        );
      });
    });

    it("registers `(..)(..)` sibling interception outside a parallel slot", async () => {
      // Ported from Next.js: test/e2e/app-dir/interception-segments-two-levels-above
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "hoge/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/(..)(..)hoge/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((route) => route.pattern);

        for (const pattern of patterns) {
          expect(pattern).not.toMatch(/\(\.{1,3}\)/);
        }

        const intercepts = collectSiblingIntercepts(graph.routes);
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/hoge",
            sourceMatchPattern: "/foo/bar",
            convention: "../..",
          }),
        );
      });
    });

    it("registers `(.)` sibling interception outside a parallel slot", async () => {
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "gallery/photo/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "gallery/(.)photo/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((route) => route.pattern);

        for (const pattern of patterns) {
          expect(pattern).not.toMatch(/\(\.{1,3}\)/);
        }

        const intercepts = collectSiblingIntercepts(graph.routes);
        // (.) resolves relative to the marker's parent dir (gallery/), so target = /gallery/photo
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/gallery/photo",
            sourceMatchPattern: "/gallery",
            convention: ".",
          }),
        );
      });
    });

    it("registers `(...)` sibling root interception outside a parallel slot", async () => {
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "target/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "deep/path/(...)target/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const patterns = graph.routes.map((route) => route.pattern);

        for (const pattern of patterns) {
          expect(pattern).not.toMatch(/\(\.{1,3}\)/);
        }

        const intercepts = collectSiblingIntercepts(graph.routes);
        expect(intercepts).toContainEqual(
          expect.objectContaining({
            targetPattern: "/target",
            sourceMatchPattern: "/deep/path",
            convention: "...",
          }),
        );
      });
    });

    it("attaches sibling intercept to ancestor route when parent dir has no page.tsx", async () => {
      // When the marker's immediate parent dir has no page, findOwnerRouteForDir must
      // walk up to the nearest ancestor that has a route.
      // Structure: deep/path/(...)target/page.tsx with NO deep/path/page.tsx.
      // The intercept should attach to the root route ("/") via ancestor walk.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "target/page.tsx", EMPTY_PAGE);
        // Note: no deep/page.tsx or deep/path/page.tsx — both intermediate dirs are empty
        await writeAppFile(appDir, "deep/path/(...)target/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());

        const intercepts = collectSiblingIntercepts(graph.routes);
        // Must not be dropped — must attach to some route via ancestor walk
        expect(intercepts.length).toBeGreaterThan(0);
        const intercept = intercepts.find((ir) => ir.targetPattern === "/target");
        expect(intercept).toBeDefined();
        // The nearest ancestor route with a page is "/" (the root)
        expect(intercept?.ownerRoute).toBe("/");
      });
    });

    describe("findOwnerRouteForDir with Windows-style separators", () => {
      // On Windows the config hook normalizes `appDir` to forward slashes,
      // but marker directories and route file paths descend through native
      // path.join/path.dirname and stay backslash. findOwnerRouteForDir must
      // compare in forward-slash space; CI is POSIX-only, so simulate the
      // Windows shapes directly.
      function makeRoute(pagePath: string, patternParts: string[]): AppRouteGraphRoute {
        return { pagePath, routePath: null, patternParts } as unknown as AppRouteGraphRoute;
      }

      const appDir = "C:/proj/app";
      const rootRoute = makeRoute("C:\\proj\\app\\page.tsx", []);
      const templatesRoute = makeRoute("C:\\proj\\app\\templates\\page.tsx", ["templates"]);
      const routes = [rootRoute, templatesRoute];
      const routesByDir = new Map([
        ["C:/proj/app", rootRoute],
        ["C:/proj/app/templates", templatesRoute],
      ]);

      it("terminates the ancestor walk at the forward-slash app root", () => {
        // deep/path has no route — the walk must stop at appDir and attach to
        // the nearest ancestor route instead of overshooting the app root.
        const owner = findOwnerRouteForDir(
          "C:\\proj\\app\\deep\\path",
          appDir,
          routes,
          routesByDir,
        );
        expect(owner).toBe(rootRoute);
      });

      it("finds the exact owner for a backslash marker parent dir", () => {
        const owner = findOwnerRouteForDir("C:\\proj\\app\\templates", appDir, routes, routesByDir);
        expect(owner).toBe(templatesRoute);
      });

      it("matches catch-all subtree routes across separator styles", () => {
        const catchAll = makeRoute("C:\\proj\\app\\templates\\[...slug]\\page.tsx", [
          "templates",
          ":slug+",
        ]);
        const owner = findOwnerRouteForDir(
          "C:\\proj\\app\\templates",
          appDir,
          [catchAll],
          new Map([["C:/proj/app/templates/[...slug]", catchAll]]),
        );
        expect(owner).toBe(catchAll);
      });

      it("resolves the root owner when the marker parent is the app root itself", () => {
        const owner = findOwnerRouteForDir(appDir, appDir, routes, routesByDir);
        expect(owner).toBe(rootRoute);
      });
    });

    it("promotes sibling interception into RouteManifest facts", async () => {
      // Sibling intercepts (no @slot) must appear in routeManifest.segmentGraph.interceptions
      // and be accessible via interceptionsBySlotId using the synthetic slot id.
      await withTempApp(async (appDir) => {
        await writeAppFile(appDir, "layout.tsx", EMPTY_LAYOUT);
        await writeAppFile(appDir, "page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "hoge/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/page.tsx", EMPTY_PAGE);
        await writeAppFile(appDir, "foo/bar/(..)(..)hoge/page.tsx", EMPTY_PAGE);

        const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
        const facts = Array.from(graph.routeManifest.segmentGraph.interceptions.values());

        expect(facts).toContainEqual(
          expect.objectContaining({
            sourcePattern: "/foo/bar",
            targetPattern: "/hoge",
            slotId: "slot:__vinext_sibling_intercept:/foo/bar",
          }),
        );

        const bySlotId = graph.routeManifest.segmentGraph.interceptionsBySlotId.get(
          "slot:__vinext_sibling_intercept:/foo/bar",
        );
        expect(bySlotId).toHaveLength(1);
        expect(bySlotId![0]).toMatchObject({
          sourcePattern: "/foo/bar",
          targetPattern: "/hoge",
        });
      });
    });
  });
});
