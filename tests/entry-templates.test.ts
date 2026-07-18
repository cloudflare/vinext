/**
 * Behavioral tests for the App Router entry-template code generators.
 *
 * Tests focus on observable behavior (structured API outputs and error paths),
 * not on the textual shape of the generated code.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import vm from "node:vm";
import { describe, it, expect } from "vite-plus/test";
import {
  generateBrowserEntry,
  toLinkPrefetchRoute,
  toLinkPrefetchRoutes,
} from "../packages/vinext/src/entries/app-browser-entry.js";
import { buildAppRscManifestCode } from "../packages/vinext/src/entries/app-rsc-manifest.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateClientEntry } from "../packages/vinext/src/entries/pages-client-entry.js";
import { generateServerEntry } from "../packages/vinext/src/entries/pages-server-entry.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { buildAppRouteGraph } from "../packages/vinext/src/routing/app-route-graph.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";

// ── Minimal App Router route fixtures ─────────────────────────────────
// Use stable absolute paths so tests don't depend on the machine.
const minimalAppRoutes: AppRoute[] = [
  {
    pattern: "/",
    patternParts: [],
    pagePath: "/tmp/test/app/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null],
    notFoundPath: null,
    notFoundPaths: [null],
    forbiddenPaths: [null],
    forbiddenPath: null,
    unauthorizedPaths: [null],
    unauthorizedPath: null,
    routeSegments: [],
    templateTreePositions: [],
    layoutTreePositions: [0],
    isDynamic: false,
    params: [],
    siblingIntercepts: [],
  },
  {
    pattern: "/about",
    patternParts: ["about"],
    pagePath: "/tmp/test/app/about/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null],
    notFoundPath: null,
    notFoundPaths: [null],
    forbiddenPaths: [null],
    forbiddenPath: null,
    unauthorizedPaths: [null],
    unauthorizedPath: null,
    routeSegments: ["about"],
    templateTreePositions: [],
    layoutTreePositions: [0],
    isDynamic: false,
    params: [],
    siblingIntercepts: [],
  },
  {
    pattern: "/blog/:slug",
    patternParts: ["blog", ":slug"],
    pagePath: "/tmp/test/app/blog/[slug]/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/blog/[slug]/layout.tsx"],
    templates: [],
    parallelSlots: [],
    loadingPath: null,
    errorPath: null,
    layoutErrorPaths: [null, null],
    notFoundPath: null,
    notFoundPaths: [null, null],
    forbiddenPaths: [null, null],
    forbiddenPath: null,
    unauthorizedPaths: [null, null],
    unauthorizedPath: null,
    routeSegments: ["blog", ":slug"],
    templateTreePositions: [],
    layoutTreePositions: [0, 1],
    isDynamic: true,
    params: ["slug"],
    siblingIntercepts: [],
  },
  {
    pattern: "/dashboard",
    patternParts: ["dashboard"],
    pagePath: "/tmp/test/app/dashboard/page.tsx",
    routePath: null,
    layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/dashboard/layout.tsx"],
    templates: ["/tmp/test/app/dashboard/template.tsx"],
    parallelSlots: [],
    loadingPath: "/tmp/test/app/dashboard/loading.tsx",
    errorPath: "/tmp/test/app/dashboard/error.tsx",
    layoutErrorPaths: [null, "/tmp/test/app/dashboard/error.tsx"],
    notFoundPath: "/tmp/test/app/dashboard/not-found.tsx",
    notFoundPaths: [null, "/tmp/test/app/dashboard/not-found.tsx"],
    forbiddenPaths: [null, "/tmp/test/app/dashboard/forbidden.tsx"],
    forbiddenPath: "/tmp/test/app/dashboard/forbidden.tsx",
    unauthorizedPaths: [null, "/tmp/test/app/dashboard/unauthorized.tsx"],
    unauthorizedPath: "/tmp/test/app/dashboard/unauthorized.tsx",
    routeSegments: ["dashboard"],
    templateTreePositions: [1],
    layoutTreePositions: [0, 1],
    isDynamic: false,
    params: [],
    siblingIntercepts: [],
  },
];

// ── App Router manifest construction ─────────────────────────────────

describe("App Router generated manifest construction", () => {
  it("embeds client rewrite rules in the App browser entry", () => {
    const code = generateBrowserEntry([], null, [], {
      afterFiles: [],
      beforeFiles: [{ source: "/legacy", destination: "/about" }],
      fallback: [],
    });

    expect(code).toContain('window.__VINEXT_CLIENT_REWRITES__ = {"afterFiles":[],"beforeFiles"');
    expect(code).toContain('"source":"/legacy","destination":"/about"');
  });

  it("embeds the Link auto-prefetch route manifest in the browser entry", () => {
    const code = generateBrowserEntry([
      ...minimalAppRoutes,
      {
        pattern: "/modal-host",
        patternParts: ["modal-host"],
        pagePath: null,
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/modal-host/layout.tsx"],
        templates: [],
        parallelSlots: [
          {
            id: "slot:panel:/modal-host",
            key: "panel@modal-host/@panel",
            name: "panel",
            ownerDir: "/tmp/test/app/modal-host/@panel",
            ownerTreePath: "/modal-host",
            ownerTreePosition: 1,
            hasPage: true,
            pagePath: "/tmp/test/app/modal-host/@panel/slow/page.tsx",
            defaultPath: null,
            layoutPath: null,
            loadingPath: null,
            loadingPaths: ["/tmp/test/app/modal-host/@panel/slow/loading.tsx"],
            loadingTreePositions: [1],
            errorPath: null,
            interceptingRoutes: [],
            layoutIndex: 1,
            routeSegments: ["slow"],
          },
        ],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null, null],
        notFoundPath: null,
        notFoundPaths: [null, null],
        forbiddenPaths: [null, null],
        forbiddenPath: null,
        unauthorizedPaths: [null, null],
        unauthorizedPath: null,
        routeSegments: ["modal-host"],
        templateTreePositions: [],
        layoutTreePositions: [0, 1],
        isDynamic: false,
        params: [],
        siblingIntercepts: [],
      },
      {
        pattern: "/docs/:slug",
        patternParts: ["docs", ":slug"],
        pagePath: "/tmp/test/app/docs/[slug]/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: "/tmp/test/app/docs/[slug]/loading.tsx",
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: null,
        notFoundPaths: [null],
        forbiddenPaths: [null],
        forbiddenPath: null,
        unauthorizedPaths: [null],
        unauthorizedPath: null,
        routeSegments: ["docs", ":slug"],
        templateTreePositions: [],
        layoutTreePositions: [0],
        isDynamic: true,
        params: ["slug"],
        siblingIntercepts: [],
      },
      {
        pattern: "/teams/:team/dashboard",
        patternParts: ["teams", ":team", "dashboard"],
        pagePath: "/tmp/test/app/teams/[team]/dashboard/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/teams/[team]/layout.tsx"],
        templates: [],
        parallelSlots: [
          {
            id: "slot:analytics:/teams/:team/dashboard",
            key: "analytics:/tmp/test/app/teams/[team]/dashboard/@analytics",
            name: "analytics",
            ownerDir: "/tmp/test/app/teams/[team]/dashboard/@analytics",
            ownerTreePath: "/teams/:team/dashboard",
            hasPage: true,
            pagePath: "/tmp/test/app/teams/[team]/dashboard/@analytics/page.tsx",
            defaultPath: "/tmp/test/app/teams/[team]/dashboard/@analytics/default.tsx",
            layoutPath: null,
            loadingPath: null,
            errorPath: null,
            interceptingRoutes: [],
            layoutIndex: 1,
            routeSegments: ["teams", ":team", "dashboard", "@analytics"],
          },
        ],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null, null],
        notFoundPath: null,
        notFoundPaths: [null, null],
        forbiddenPaths: [null, null],
        forbiddenPath: null,
        unauthorizedPaths: [null, null],
        unauthorizedPath: null,
        routeSegments: ["teams", ":team", "dashboard"],
        templateTreePositions: [],
        layoutTreePositions: [0, 1],
        isDynamic: true,
        params: ["team"],
        siblingIntercepts: [],
      },
      {
        pattern: "/api",
        patternParts: ["api"],
        pagePath: null,
        routePath: "/tmp/test/app/api/route.ts",
        layouts: [],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [],
        notFoundPath: null,
        notFoundPaths: [],
        forbiddenPaths: [],
        forbiddenPath: null,
        unauthorizedPaths: [],
        unauthorizedPath: null,
        routeSegments: ["api"],
        templateTreePositions: [],
        layoutTreePositions: [],
        isDynamic: false,
        params: [],
        siblingIntercepts: [],
      },
      {
        ...minimalAppRoutes[0],
        pattern: "/ancestor-loading/slow",
        patternParts: ["ancestor-loading", "slow"],
        pagePath: "/tmp/test/app/ancestor-loading/slow/page.tsx",
        loadingPath: null,
        loadingPaths: ["/tmp/test/app/ancestor-loading/loading.tsx"],
        loadingTreePositions: [1],
        routeSegments: ["ancestor-loading", "slow"],
      },
    ]);

    expect(code).toContain("import { registerNavigationRuntimeBootstrap } from ");
    expect(code).toContain("window.__VINEXT_LINK_PREFETCH_ROUTES__ = ");
    expect(code).toContain("registerNavigationRuntimeBootstrap({");
    expect(code).toContain("routeManifest: null");
    expect(code).toContain(
      '{"canPrefetchLoadingShell":false,"patternParts":["about"],"isDynamic":false}',
    );
    expect(code).toContain(
      '{"canPrefetchLoadingShell":false,"patternParts":["blog",":slug"],"isDynamic":true}',
    );
    expect(code).toContain(
      '{"canPrefetchLoadingShell":true,"patternParts":["docs",":slug"],"isDynamic":true}',
    );
    expect(code).toContain(
      '{"canPrefetchLoadingShell":true,"patternParts":["ancestor-loading","slow"],"isDynamic":false}',
    );
    expect(code).toContain(
      '{"canPrefetchLoadingShell":false,"patternParts":["teams",":team","dashboard"],"isDynamic":true,"requiresDynamicNavigationRequest":true}',
    );
    expect(code).toContain(
      '{"canPrefetchLoadingShell":true,"patternParts":["modal-host"],"isDynamic":false}',
    );
    expect(code).not.toContain(
      '{"canPrefetchLoadingShell":false,"patternParts":["api"],"isDynamic":false}',
    );
  });

  it("advertises loading-shell prefetch for intercept-only loading boundaries", () => {
    const route = {
      ...minimalAppRoutes[0],
      pattern: "/slow-intercept/photo",
      patternParts: ["slow-intercept", "photo"],
      parallelSlots: [
        {
          id: "slot:modal:/slow-intercept",
          key: "modal@slow-intercept/@modal",
          name: "modal",
          ownerDir: "/tmp/test/app/slow-intercept/@modal",
          ownerTreePath: "/slow-intercept",
          ownerTreePosition: 1,
          hasPage: false,
          pagePath: null,
          defaultPath: "/tmp/test/app/slow-intercept/@modal/default.tsx",
          layoutPath: null,
          loadingPath: null,
          loadingPaths: [],
          loadingTreePositions: [],
          errorPath: null,
          interceptingRoutes: [
            {
              convention: ".",
              targetPattern: "/slow-intercept/photo",
              sourceMatchPattern: "/slow-intercept",
              pagePath: "/tmp/test/app/slow-intercept/@modal/(.)photo/page.tsx",
              layoutPaths: [],
              loadingPaths: ["/tmp/test/app/slow-intercept/@modal/(.)photo/loading.tsx"],
              loadingTreePositions: [1],
              params: [],
            },
          ],
          layoutIndex: 0,
          routeSegments: null,
        },
      ],
      routeSegments: ["slow-intercept", "photo"],
    } satisfies AppRoute;

    expect(toLinkPrefetchRoute(route).canPrefetchLoadingShell).toBe(true);
    expect(
      toLinkPrefetchRoute({
        ...route,
        pattern: "/slow-intercept",
        patternParts: ["slow-intercept"],
        routeSegments: ["slow-intercept"],
      }).canPrefetchLoadingShell,
    ).toBe(false);
  });

  it("advertises sibling-intercept loading only on the target route", () => {
    const sourceRoute = {
      ...minimalAppRoutes[0],
      pattern: "/feed",
      patternParts: ["feed"],
      routeSegments: ["feed"],
      siblingIntercepts: [
        {
          convention: ".",
          targetPattern: "/feed/photo/:photoId",
          sourceMatchPattern: "/feed",
          pagePath: "/tmp/test/app/feed/(.)photo/[photoId]/page.tsx",
          layoutPaths: [],
          loadingPaths: ["/tmp/test/app/feed/(.)photo/[photoId]/loading.tsx"],
          loadingTreePositions: [1],
          params: ["photoId"],
        },
      ],
    } satisfies AppRoute;
    const targetRoute = {
      ...minimalAppRoutes[0],
      pattern: "/feed/photo/:id",
      patternParts: ["feed", "photo", ":id"],
      routeSegments: ["feed", "photo", ":id"],
      isDynamic: true,
      params: ["id"],
    } satisfies AppRoute;
    const unrelatedRoute = {
      ...minimalAppRoutes[0],
      pattern: "/feed/video/:id",
      patternParts: ["feed", "video", ":id"],
      routeSegments: ["feed", "video", ":id"],
      isDynamic: true,
      params: ["id"],
    } satisfies AppRoute;

    const [source, target, unrelated] = toLinkPrefetchRoutes([
      sourceRoute,
      targetRoute,
      unrelatedRoute,
    ]);
    expect(source.canPrefetchLoadingShell).toBe(false);
    expect(target.canPrefetchLoadingShell).toBe(true);
    expect(unrelated.canPrefetchLoadingShell).toBe(false);
  });

  it("embeds the RouteManifest read model in the browser entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-browser-route-manifest-"));
    const appDir = path.join(tmpDir, "app");
    try {
      fs.mkdirSync(path.join(appDir, "dashboard"), { recursive: true });
      fs.writeFileSync(path.join(appDir, "layout.tsx"), "export default function Layout() {}\n");
      fs.writeFileSync(path.join(appDir, "page.tsx"), "export default function Page() {}\n");
      fs.writeFileSync(
        path.join(appDir, "dashboard", "page.tsx"),
        "export default function Page() {}\n",
      );

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const code = generateBrowserEntry(graph.routes, graph.routeManifest);

      expect(code).toContain("registerNavigationRuntimeBootstrap({");
      expect(code).toContain("graphVersion:");
      expect(code).toContain("routes: new Map(");
      expect(code).toContain("rootBoundaries: new Map(");
      expect(code).toContain('"route:/dashboard"');
      expect(code).toContain('"root-boundary:/"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("constructs route module imports and route entries from the scanned app shape", () => {
    const routes = [
      {
        pattern: "/",
        patternParts: [],
        pagePath: "/tmp/test/app/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: "/tmp/test/app/not-found.tsx",
        notFoundPaths: ["/tmp/test/app/not-found.tsx"],
        forbiddenPath: "/tmp/test/app/forbidden.tsx",
        forbiddenPaths: ["/tmp/test/app/forbidden.tsx"],
        unauthorizedPath: "/tmp/test/app/unauthorized.tsx",
        unauthorizedPaths: ["/tmp/test/app/unauthorized.tsx"],
        routeSegments: [],
        templateTreePositions: [],
        layoutTreePositions: [0],
        isDynamic: false,
        params: [],
        siblingIntercepts: [],
      },
      {
        ids: {
          route: "route:/dashboard/:id",
          page: "page:/dashboard/:id",
          routeHandler: "route-handler:/dashboard/:id",
          rootBoundary: "root-boundary:/",
          layouts: ["layout:/", "layout:/dashboard"],
          templates: ["template:/dashboard"],
          slots: {
            "modal:/tmp/test/app/dashboard/@modal": "slot:modal:/dashboard",
          },
        },
        pattern: "/dashboard/:id",
        patternParts: ["dashboard", ":id"],
        pagePath: "/tmp/test/app/dashboard/[id]/page.tsx",
        routePath: "/tmp/test/app/dashboard/[id]/route.ts",
        layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/dashboard/layout.tsx"],
        templates: ["/tmp/test/app/dashboard/template.tsx"],
        parallelSlots: [
          {
            id: "slot:modal:/dashboard",
            key: "modal:/tmp/test/app/dashboard/@modal",
            name: "modal",
            ownerDir: "/tmp/test/app/dashboard/@modal",
            ownerTreePath: "/dashboard",
            hasPage: true,
            pagePath: "/tmp/test/app/dashboard/@modal/page.tsx",
            defaultPath: "/tmp/test/app/dashboard/@modal/default.tsx",
            layoutPath: "/tmp/test/app/dashboard/@modal/layout.tsx",
            loadingPath: "/tmp/test/app/dashboard/@modal/loading.tsx",
            errorPath: "/tmp/test/app/dashboard/@modal/error.tsx",
            interceptingRoutes: [
              {
                convention: ".",
                targetPattern: "/photos/:photoId",
                sourceMatchPattern: "/dashboard",
                pagePath: "/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx",
                layoutPaths: ["/tmp/test/app/dashboard/@modal/(.)photos/layout.tsx"],
                params: ["photoId"],
              },
            ],
            layoutIndex: 1,
            routeSegments: ["@modal"],
          },
        ],
        loadingPath: "/tmp/test/app/dashboard/loading.tsx",
        errorPath: "/tmp/test/app/dashboard/error.tsx",
        layoutErrorPaths: [null, "/tmp/test/app/dashboard/error.tsx"],
        notFoundPath: "/tmp/test/app/dashboard/not-found.tsx",
        notFoundPaths: ["/tmp/test/app/not-found.tsx", "/tmp/test/app/dashboard/not-found.tsx"],
        forbiddenPath: null,
        forbiddenPaths: ["/tmp/test/app/forbidden.tsx", null],
        unauthorizedPath: null,
        unauthorizedPaths: ["/tmp/test/app/unauthorized.tsx", null],
        routeSegments: ["dashboard", "[id]"],
        templateTreePositions: [1],
        layoutTreePositions: [0, 1],
        isDynamic: true,
        params: ["id"],
        rootParamNames: ["id"],
        siblingIntercepts: [],
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: "/tmp/test/app/global-error.tsx",
    });

    const imports = manifest.imports.join("\n");
    // The root layout stays eager (`import * as`, always needed for every
    // render) and is additionally referenced by a lazy loader for the route's
    // `layouts` array, so its path appears in both an eager and a lazy import.
    expect(imports.match(/\/tmp\/test\/app\/layout\.tsx/g)).toHaveLength(2);
    // Every per-route module — pages, route handlers, layouts, templates,
    // boundaries and intercepting pages/layouts — is emitted as a lazy `() =>
    // import()` loader. Only the always-needed root boundaries (root layout,
    // not-found/forbidden/unauthorized) and global-error stay eager `import * as`.
    expect(imports).toContain('const load_0 = () => import("/tmp/test/app/page.tsx");');
    expect(imports).toContain(
      'const load_5 = () => import("/tmp/test/app/dashboard/[id]/page.tsx");',
    );
    expect(imports).toContain(
      'const load_6 = () => import("/tmp/test/app/dashboard/[id]/route.ts");',
    );
    expect(imports).toContain(
      'const load_17 = () => import("/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx");',
    );
    expect(imports).toContain('import * as mod_4 from "/tmp/test/app/global-error.tsx";');

    expect(manifest.rootNotFoundVar).toBe("mod_0");
    expect(manifest.rootForbiddenVar).toBe("mod_1");
    expect(manifest.rootUnauthorizedVar).toBe("mod_2");
    expect(manifest.rootLayoutVars).toEqual(["mod_3"]);
    expect(manifest.globalErrorVar).toBe("mod_4");

    const dynamicRouteEntry = manifest.routeEntries[1];
    expect(dynamicRouteEntry).toContain('"route":"route:/dashboard/:id"');
    expect(dynamicRouteEntry).toContain(
      '"modal:/tmp/test/app/dashboard/@modal":"slot:modal:/dashboard"',
    );
    expect(dynamicRouteEntry).toContain('id: "slot:modal:/dashboard"');
    expect(dynamicRouteEntry).toContain('pattern: "/dashboard/:id"');
    expect(dynamicRouteEntry).toContain("page: null");
    expect(dynamicRouteEntry).toContain("__loadPage: load_5");
    expect(dynamicRouteEntry).toContain("routeHandler: null");
    expect(dynamicRouteEntry).toContain("__loadRouteHandler: load_6");
    // Layouts are `null` placeholders hydrated on demand from `__loadLayouts`.
    expect(dynamicRouteEntry).toContain("layouts: [null, null]");
    expect(dynamicRouteEntry).toContain("__loadLayouts: [load_1, load_7]");
    expect(dynamicRouteEntry).toContain('"modal:/tmp/test/app/dashboard/@modal": {');
    expect(dynamicRouteEntry).toContain("interceptLayouts: [null]");
    expect(dynamicRouteEntry).toContain("__loadInterceptLayouts: [load_18]");
    expect(dynamicRouteEntry).toContain("page: null");
    expect(dynamicRouteEntry).toContain("__pageLoader: load_17");
    expect(dynamicRouteEntry).toContain('params: ["photoId"]');
    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/dashboard/:id": __createAppPrerenderStaticParamsResolver([{ load: load_5 }], ["id"]),',
    ]);
  });

  it("emits lazy per-segment loading modules with their tree positions", () => {
    const route = {
      ...minimalAppRoutes[0],
      pattern: "/parent/slow",
      patternParts: ["parent", "slow"],
      pagePath: "/tmp/test/app/parent/slow/page.tsx",
      loadingPath: "/tmp/test/app/parent/slow/loading.tsx",
      loadingPaths: ["/tmp/test/app/parent/loading.tsx", "/tmp/test/app/parent/slow/loading.tsx"],
      loadingTreePositions: [1, 2],
      routeSegments: ["parent", "slow"],
    } satisfies AppRoute;

    const manifest = buildAppRscManifestCode({ routes: [route] });
    const routeEntry = manifest.routeEntries[0];

    expect(manifest.imports.join("\n")).toContain("/tmp/test/app/parent/loading.tsx");
    expect(manifest.imports.join("\n")).toContain("/tmp/test/app/parent/slow/loading.tsx");
    expect(routeEntry).toContain("loadings: [null, null]");
    expect(routeEntry).toContain("__loadLoadings: [load_");
    expect(routeEntry).toContain("loadingTreePositions: [1,2]");
  });

  it("emits positional loading modules for named slots and intercepted branches", () => {
    const route = {
      ...minimalAppRoutes[0],
      parallelSlots: [
        {
          id: "slot:modal:/",
          key: "modal@modal",
          name: "modal",
          ownerDir: "/tmp/test/app/@modal",
          ownerTreePath: "/",
          ownerTreePosition: 0,
          hasPage: true,
          pagePath: "/tmp/test/app/@modal/nested/page.tsx",
          defaultPath: null,
          layoutPath: null,
          configLayoutPaths: [],
          configLayoutTreePositions: [],
          loadingPath: "/tmp/test/app/@modal/loading.tsx",
          loadingPaths: [
            "/tmp/test/app/@modal/loading.tsx",
            "/tmp/test/app/@modal/nested/loading.tsx",
          ],
          loadingTreePositions: [0, 1],
          errorPath: null,
          interceptingRoutes: [
            {
              convention: ".",
              targetPattern: "/photo/:id",
              sourceMatchPattern: "/",
              pagePath: "/tmp/test/app/@modal/(.)photo/[id]/page.tsx",
              layoutPaths: [],
              loadingPaths: ["/tmp/test/app/@modal/(.)photo/loading.tsx"],
              loadingTreePositions: [1],
              params: ["id"],
            },
          ],
          layoutIndex: 0,
          routeSegments: ["nested"],
        },
      ],
    } satisfies AppRoute;

    const manifest = buildAppRscManifestCode({ routes: [route] });
    const imports = manifest.imports.join("\n");
    const routeEntry = manifest.routeEntries[0];

    expect(imports).toContain("/tmp/test/app/@modal/nested/loading.tsx");
    expect(imports).toContain("/tmp/test/app/@modal/(.)photo/loading.tsx");
    expect(routeEntry).toContain("ownerTreePosition: 0");
    expect(routeEntry).toContain("loadings: [null, null]");
    expect(routeEntry).toContain("loadingTreePositions: [0,1]");
    expect(routeEntry).toContain("interceptLoadings: [null]");
    expect(routeEntry).toContain("interceptLoadingTreePositions: [1]");
  });

  it("derives route-miss root boundaries when the app has no root page", () => {
    const routes = [
      {
        pattern: "/server",
        patternParts: ["server"],
        pagePath: "/tmp/test/app/server/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: "/tmp/test/app/not-found.tsx",
        notFoundPaths: ["/tmp/test/app/not-found.tsx"],
        forbiddenPath: null,
        forbiddenPaths: ["/tmp/test/app/forbidden.tsx"],
        unauthorizedPath: null,
        unauthorizedPaths: ["/tmp/test/app/unauthorized.tsx"],
        routeSegments: ["server"],
        templateTreePositions: [],
        layoutTreePositions: [0],
        isDynamic: false,
        params: [],
        siblingIntercepts: [],
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: null,
    });

    // Every per-route module is lazy-loaded, so the eager `import * as mod_N`
    // numbering starts at the always-eager root boundaries: not-found,
    // forbidden, unauthorized, then the root layout.
    expect(manifest.rootNotFoundVar).toBe("mod_0");
    expect(manifest.rootForbiddenVar).toBe("mod_1");
    expect(manifest.rootUnauthorizedVar).toBe("mod_2");
    expect(manifest.rootLayoutVars).toEqual(["mod_3"]);
  });

  it("exposes layout-level generateStaticParams to App Router prerender", () => {
    // Ported from Next.js: test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-root-params-getters/generate-static-params.test.ts
    const routes = [
      {
        pattern: "/:lang/:locale/other/:slug",
        patternParts: [":lang", ":locale", "other", ":slug"],
        pagePath: "/tmp/test/app/[lang]/[locale]/other/[slug]/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/[lang]/[locale]/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: null,
        notFoundPaths: [null],
        forbiddenPath: null,
        forbiddenPaths: [null],
        unauthorizedPath: null,
        unauthorizedPaths: [null],
        routeSegments: ["[lang]", "[locale]", "other", "[slug]"],
        templateTreePositions: [],
        layoutTreePositions: [2],
        isDynamic: true,
        params: ["lang", "locale", "slug"],
        rootParamNames: ["lang", "locale"],
        siblingIntercepts: [],
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: null,
    });

    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/:lang/:locale": __createAppPrerenderStaticParamsResolver([{ load: load_1 }], ["lang","locale"]),',
      '  "/:lang/:locale/other/:slug": __createAppPrerenderStaticParamsResolver([{ load: load_0 }], ["lang","locale"]),',
    ]);
    expect(manifest.rootParamNameEntries).toEqual([
      '  "/:lang/:locale/other/:slug": ["lang","locale"],',
      '  "/:lang/:locale": ["lang","locale"],',
    ]);
  });

  it("keys layout generateStaticParams with canonical decoded route patterns", () => {
    const routes = [
      {
        pattern: "/:lang/docs v2/:section/:slug",
        patternParts: [":lang", "docs v2", ":section", ":slug"],
        pagePath: "/tmp/test/app/[lang]/docs%20v2/[section]/[slug]/page.tsx",
        routePath: null,
        layouts: ["/tmp/test/app/[lang]/docs%20v2/[section]/layout.tsx"],
        templates: [],
        parallelSlots: [],
        loadingPath: null,
        errorPath: null,
        layoutErrorPaths: [null],
        notFoundPath: null,
        notFoundPaths: [null],
        forbiddenPath: null,
        forbiddenPaths: [null],
        unauthorizedPath: null,
        unauthorizedPaths: [null],
        routeSegments: ["[lang]", "docs%20v2", "[section]", "[slug]"],
        templateTreePositions: [],
        layoutTreePositions: [3],
        isDynamic: true,
        params: ["lang", "section", "slug"],
        rootParamNames: ["lang", "section"],
        siblingIntercepts: [],
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: null,
    });

    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/:lang/docs v2/:section": __createAppPrerenderStaticParamsResolver([{ load: load_1 }], ["lang","section"]),',
      '  "/:lang/docs v2/:section/:slug": __createAppPrerenderStaticParamsResolver([{ load: load_0 }], ["lang","section"]),',
    ]);
    expect(manifest.rootParamNameEntries).toEqual([
      '  "/:lang/docs v2/:section/:slug": ["lang","section"],',
      '  "/:lang/docs v2/:section": ["lang","section"],',
    ]);
  });

  it("emits a dynamic-import specifier for the global-not-found module when provided", () => {
    // Mirrors how vinext scans `app/global-not-found.tsx` in
    // packages/vinext/src/index.ts and threads it into the manifest so the
    // generated RSC entry can hand it to createAppFallbackRenderer.
    //
    // The module is intentionally NOT registered as a static `import * as` —
    // statically importing it co-locates global-not-found's CSS with the root
    // layout's CSS in a single chunk, and the CSS minifier (lightningcss) then
    // drops overlapping declarations as dead code, breaking the cascade for
    // route-miss 404s. Emitting a JSON-encoded specifier lets the entry
    // generator wrap the path in a dynamic `import()` for chunk isolation.
    // See https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found
    // See Next.js test: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
    const manifest = buildAppRscManifestCode({
      routes: minimalAppRoutes,
      metadataRoutes: [],
      globalErrorPath: null,
      globalNotFoundPath: "/tmp/test/app/global-not-found.tsx",
    });

    // Must NOT appear in the static imports — that would defeat the chunk
    // isolation. The entry generator embeds it via `() => import(<specifier>)`.
    expect(manifest.imports.join("\n")).not.toContain("global-not-found");
    expect(manifest.globalNotFoundImportSpecifier).toBe('"/tmp/test/app/global-not-found.tsx"');
  });

  it("does not emit a global-not-found specifier when the path is absent", () => {
    const manifest = buildAppRscManifestCode({
      routes: minimalAppRoutes,
      metadataRoutes: [],
      globalErrorPath: null,
      globalNotFoundPath: null,
    });

    expect(manifest.imports.join("\n")).not.toContain("global-not-found");
    expect(manifest.globalNotFoundImportSpecifier).toBeNull();
  });

  it("serializes graph-minted ids without leaking the filesystem root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-manifest-"));
    const appDir = path.join(tmpDir, "app");
    try {
      fs.mkdirSync(path.join(appDir, "(marketing)", "blog", "[slug]", "@modal"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(appDir, "layout.tsx"), "export default function Layout() {}\n");
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "layout.tsx"),
        "export default function Layout() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "layout.tsx"),
        "export default function Layout() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "template.tsx"),
        "export default function Template() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "page.tsx"),
        "export default function Page() {}\n",
      );
      fs.writeFileSync(
        path.join(appDir, "(marketing)", "blog", "[slug]", "@modal", "default.tsx"),
        "export default function Default() {}\n",
      );

      const graph = await buildAppRouteGraph(appDir, createValidFileMatcher());
      const manifest = buildAppRscManifestCode({
        routes: graph.routes,
        metadataRoutes: [],
        globalErrorPath: null,
      });

      const routeEntry = manifest.routeEntries.find((entry) =>
        entry.includes('pattern: "/blog/:slug"'),
      );

      expect(routeEntry).toBeDefined();
      expect(routeEntry).not.toContain(appDir);
      expect(routeEntry).toContain('"route":"route:/blog/:slug"');
      expect(routeEntry).toContain('"page":"page:/blog/:slug"');
      expect(routeEntry).toContain('"layout:/(marketing)/blog/[slug]"');
      expect(routeEntry).toContain('"template:/(marketing)/blog/[slug]"');
      expect(routeEntry).toContain(
        '"modal@(marketing)/blog/[slug]/@modal":"slot:modal:/(marketing)/blog/[slug]"',
      );
      expect(routeEntry).toContain('id: "slot:modal:/(marketing)/blog/[slug]"');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("embeds static metadata files and imports dynamic metadata modules", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-manifest-"));
    try {
      const staticManifestPath = path.join(tmpDir, "manifest.webmanifest");
      const dynamicOgPath = path.join(tmpDir, "blog", "[slug]", "opengraph-image.tsx");
      fs.mkdirSync(path.dirname(dynamicOgPath), { recursive: true });
      fs.writeFileSync(staticManifestPath, '{"name":"Vinext"}');
      fs.writeFileSync(dynamicOgPath, "export default function Image() {}");

      const manifest = buildAppRscManifestCode({
        routes: minimalAppRoutes,
        metadataRoutes: [
          {
            type: "manifest",
            isDynamic: false,
            filePath: staticManifestPath,
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
          {
            type: "opengraph-image",
            isDynamic: true,
            filePath: dynamicOgPath,
            routePrefix: "/blog/[slug]",
            routeSegments: ["blog", "[slug]"],
            servedUrl: "/blog/[slug]/opengraph-image",
            contentType: "image/png",
          },
        ],
        globalErrorPath: null,
      });

      const entries = manifest.metaRouteEntries.join("\n");
      expect(entries).toContain(
        `fileDataBase64: ${JSON.stringify(Buffer.from('{"name":"Vinext"}').toString("base64"))}`,
      );
      // Dynamic metadata modules get imported and referenced with a generated name
      expect(entries).toMatch(/module: mod_\d+/);
      expect(manifest.imports.some((imp) => imp.includes("opengraph-image.tsx"))).toBe(true);
      expect(entries).toContain('patternParts: ["blog",":slug","opengraph-image"]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws a build-time error when a discovered static metadata file cannot be read", () => {
    expect(() =>
      buildAppRscManifestCode({
        routes: minimalAppRoutes,
        metadataRoutes: [
          {
            type: "manifest",
            isDynamic: false,
            filePath: "/tmp/test/app/missing-manifest.webmanifest",
            routePrefix: "",
            routeSegments: [],
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
        ],
        globalErrorPath: null,
      }),
    ).toThrow("[vinext] Failed to read metadata route file");
  });
});

// ── App Router entry template error paths ────────────────────────────

describe("App Router entry templates", () => {
  it("installs server globals before App Router user modules are imported", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    const globalsImportIndex = code.indexOf("/server-globals.js");
    // The root page is a static route, so it is emitted as a lazy loader
    // (`const load_N = () => import(...)`) rather than a static `import * as`.
    const firstUserImportIndex = code.search(
      /const load_\d+ = \(\) => import\("\/tmp\/test\/app\/page\.tsx"\);/,
    );

    expect(globalsImportIndex).toBeGreaterThanOrEqual(0);
    expect(firstUserImportIndex).toBeGreaterThanOrEqual(0);
    expect(globalsImportIndex).toBeLessThan(firstUserImportIndex);
  });

  it("generateRscEntry fails with a path-specific error when a static metadata file cannot be read", () => {
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath: "/tmp/test/app/missing-icon.png",
        routePrefix: "",
        servedUrl: "/icon.png",
        contentType: "image/png",
      },
    ];

    expect(() =>
      generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
    ).toThrow("[vinext] Failed to read metadata route file /tmp/test/app/missing-icon.png");
  });

  it("generateRscEntry fails with a path-specific error when a dynamic metadata file hash cannot be read", () => {
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: true,
        filePath: "/tmp/test/app/missing-icon.tsx",
        routePrefix: "",
        servedUrl: "/icon",
        contentType: "image/png",
      },
    ];

    expect(() =>
      generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
    ).toThrow("[vinext] Failed to read metadata route file /tmp/test/app/missing-icon.tsx");
  });

  it("generateRscEntry fails with a path-specific error when static image dimensions cannot be read", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-metadata-"));
    const filePath = path.join(tmpDir, "icon.png");
    fs.writeFileSync(filePath, "not a png");
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "icon",
        isDynamic: false,
        filePath,
        routePrefix: "",
        servedUrl: "/icon.png",
        contentType: "image/png",
      },
    ];

    try {
      expect(() =>
        generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
      ).toThrow(`[vinext] Failed to read metadata image dimensions for ${filePath} (/icon.png)`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generateRscEntry does not read image dimensions for static text metadata files", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-metadata-"));
    const filePath = path.join(tmpDir, "manifest.json");
    fs.writeFileSync(filePath, JSON.stringify({ name: "test" }));
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "manifest",
        isDynamic: false,
        filePath,
        routePrefix: "",
        servedUrl: "/manifest.webmanifest",
        contentType: "application/manifest+json",
      },
    ];

    try {
      expect(() =>
        generateRscEntry("/tmp/test/app", minimalAppRoutes, null, metadataRoutes, null, "", false),
      ).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generateRscEntry delegates App Router request handling to the typed helper", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain('import { createAppRscHandler } from "vinext/server/app-rsc-handler";');
    expect(code).toContain("export default createAppRscHandler({");
    expect(code).not.toContain("computeRscCacheBustingSearchParam(");
  });

  it("generateRscEntry only includes the App middleware runtime when middleware exists", () => {
    const withoutMiddleware = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      null,
      "",
      false,
    );
    const withMiddleware = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      "/tmp/test/middleware.ts",
      [],
      null,
      "",
      false,
    );

    expect(withoutMiddleware).not.toContain("app-middleware.js");
    expect(withoutMiddleware).not.toContain("runMiddleware(");
    expect(withMiddleware).toContain("app-middleware.js");
    expect(withMiddleware).toContain("runMiddleware({ cleanPathname, context, hadBasePath");
    expect(withMiddleware).toContain("return __applyAppMiddleware({");
    expect(withMiddleware).toContain("hadBasePath,");
  });

  it("generateRscEntry only includes the PPR runtime when Cache Components is enabled", () => {
    const withoutCacheComponents = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      null,
      "",
      false,
    );
    const withCacheComponents = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      null,
      "",
      false,
      { cacheComponents: true },
    );

    expect(withoutCacheComponents).not.toContain("app-page-ppr-runtime.js");
    expect(withoutCacheComponents).not.toContain("createPprFallbackShells(route, params)");
    expect(withoutCacheComponents).toContain("pprRuntime: undefined");
    expect(withCacheComponents).toContain("app-page-ppr-runtime.js");
    expect(withCacheComponents).toContain("createPprFallbackShells(route, params)");
    expect(withCacheComponents).toContain("pprRuntime: __appPagePprRuntime");
  });

  it("generateRscEntry only includes metadata route response handling when routes exist", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-metadata-runtime-"));
    const filePath = path.join(tmpDir, "sitemap.ts");
    fs.writeFileSync(filePath, "export default function sitemap() { return []; }");

    try {
      const withoutMetadataRoutes = generateRscEntry(
        "/tmp/test/app",
        minimalAppRoutes,
        null,
        [],
        null,
        "",
        false,
      );
      const withMetadataRoutes = generateRscEntry(
        "/tmp/test/app",
        minimalAppRoutes,
        null,
        [
          {
            type: "sitemap",
            isDynamic: true,
            filePath,
            routePrefix: "",
            servedUrl: "/sitemap.xml",
            contentType: "application/xml",
          },
        ],
        null,
        "",
        false,
      );

      expect(withoutMetadataRoutes).not.toContain("metadata-route-response.js");
      expect(withoutMetadataRoutes).not.toContain("file-based-metadata.js");
      expect(withoutMetadataRoutes).not.toContain("handleMetadataRouteRequest(cleanPathname)");
      expect(withMetadataRoutes).toContain("metadata-route-response.js");
      expect(withMetadataRoutes).toContain("file-based-metadata.js");
      expect(withMetadataRoutes).toContain("applyFileBasedMetadata: __applyFileBasedMetadata");
      expect(withMetadataRoutes).toContain("handleMetadataRouteRequest(cleanPathname)");
      expect(withMetadataRoutes).toContain("await __loadMetadataRouteResponse()");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("generateRscEntry defers route-handler and server-action runtimes", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain('const __loadAppRouteHandlerDispatch = () => import("');
    expect(code).toContain('const __loadAppServerActionExecution = () => import("');
    expect(code).toContain("await __loadAppRouteHandlerDispatch()");
    expect(code).toContain("await __loadAppServerActionExecution()");
    expect(code).not.toMatch(/import \{\s*dispatchAppRouteHandler as __dispatchAppRouteHandler,/);
    expect(code).not.toMatch(
      /import \{\s*handleProgressiveServerActionRequest as __handleProgressiveServerActionRequest,/,
    );
  });

  it("generateRscEntry omits server action imports when no server references were found", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      hasServerActions: false,
    });

    expect(code).toContain('from "@vitejs/plugin-rsc/react/rsc"');
    expect(code).not.toContain("app-server-action-execution.js");
    expect(code).not.toContain("decodeAction,");
    expect(code).not.toContain("decodeFormState,");
    expect(code).not.toContain("decodeReply,");
    expect(code).not.toContain("loadServerAction,");
    expect(code).not.toContain("createTemporaryReferenceSet,");
    expect(code).not.toContain("handleProgressiveActionRequest({");
    expect(code).not.toContain("handleServerActionRequest({");
  });

  it("generateRscEntry passes parallel route segment config into App page dispatch", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain(
      "parallelSegments: Object.values(route.slots ?? {}).flatMap((slot) => [",
    );
    expect(code).toContain(
      "parallelPages: Object.values(route.slots ?? {}).map((slot) => slot.page ?? slot.default)",
    );
    expect(code).toContain("parallelBranches: Object.values(route.slots ?? {}).map((slot) => ({");
    expect(code).toContain("paramNames: slot.slotParamNames");
    expect(code).toContain("patternParts: slot.slotPatternParts");
    expect(code).toContain("layout: slot.layout");
    expect(code).toContain("configLayouts: slot.configLayouts");
    expect(code).toContain("configLayoutTreePositions: slot.configLayoutTreePositions");
    expect(code).toContain("routeSegments: slot.routeSegments");
    expect(code).toContain("routePatternParts: route.patternParts");
    expect(code).toContain("slot.page ?? slot.default");
    expect(code).toContain("...(slot.configLayouts ?? [])");
    expect(code).toContain("interceptLayoutSegments:");
    expect(code).toContain("interceptBranchSegments:");
    expect(code).toContain("dynamicStaleTimeSeconds: __segmentConfig.dynamicStaleTimeSeconds");
    expect(code).toContain("? __isEdgeRuntime(__resolveRouteRuntime(__actionMatch.route))");
    expect(code).toContain(
      "const __isEdge = route ? __isEdgeRuntime(__resolveRouteRuntime(route))",
    );
  });

  it("generateRscEntry threads globalNotFoundPath from config into the fallback renderer", () => {
    // The generated entry's createAppFallbackRenderer call must receive a
    // loader so route-miss 404s can render app/global-not-found.tsx standalone.
    //
    // The loader is a dynamic `import()` (not a static `import * as`) so the
    // bundler emits global-not-found.tsx in its own JS+CSS chunk. Without that
    // isolation, the CSS minifier (lightningcss) drops overlapping declarations
    // between the root layout's CSS and global-not-found's CSS, breaking the
    // cascade for route-miss 404s.
    // See packages/vinext/src/entries/app-rsc-entry.ts and
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/global-not-found
    // See Next.js test: test/e2e/app-dir/initial-css-order/initial-css-order.test.ts
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      globalNotFound: true,
      globalNotFoundPath: "/tmp/test/app/global-not-found.tsx",
    });

    // Loader uses dynamic `import()` — NOT a static `import * as`.
    expect(code).toContain('() => import("/tmp/test/app/global-not-found.tsx")');
    expect(code).not.toContain('from "/tmp/test/app/global-not-found.tsx"');
    // The renderer is wired with the loader binding (not just `null`).
    expect(code).toContain("loadGlobalNotFoundModule: __loadGlobalNotFoundModule");
    expect(code).not.toContain("const __loadGlobalNotFoundModule = null;");
  });

  it("generateRscEntry emits a null global-not-found loader when no path is provided", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      globalNotFound: true,
    });

    expect(code).toContain("const __loadGlobalNotFoundModule = null;");
    expect(code).toContain("globalNotFoundEnabled: true");
    expect(code).not.toContain("global-not-found.tsx");
  });

  it("generateRscEntry ignores global-not-found modules when the feature is disabled", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      globalNotFound: false,
      globalNotFoundPath: "/tmp/test/app/global-not-found.tsx",
    });

    expect(code).toContain("const __loadGlobalNotFoundModule = null;");
    expect(code).toContain("globalNotFoundEnabled: false");
    expect(code).not.toContain("global-not-found.tsx");
  });

  it("generateRscEntry delegates React Flight preload hint normalization", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("createRscRenderer");
    expect(code).toContain(
      "const renderToReadableStream = createRscRenderer(_renderToReadableStream",
    );
    expect(code).not.toContain("const _hlFixRe =");
  });
});

// ── Pages Router entry template runtime bootstrap ─────────────────────

describe("Pages Router entry template", () => {
  it("reports trusted _next/data classification from URL normalization", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-data-entry-"));
    const pagesDir = path.join(tmpDir, "pages");
    const middlewarePath = path.join(tmpDir, "middleware.ts");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );
      fs.writeFileSync(
        middlewarePath,
        'export function middleware() { return new Response(null, { headers: { "x-middleware-next": "1" } }); }',
      );

      const code = await generateServerEntry(
        pagesDir,
        await resolveNextConfig({
          basePath: "/root",
          generateBuildId: () => "test-build-id",
        }),
        createValidFileMatcher(),
        middlewarePath,
        null,
      );

      expect(code).toContain("export function normalizeDataRequest(request)");
      expect(code).toContain(
        "vinextConfig.basePath,\n    hasMiddleware && vinextConfig.trailingSlash",
      );
      expect(code).toContain("export const hasMiddleware = true");
      expect(code).not.toContain('request.headers.get("x-nextjs-data")');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("installs server globals before Pages Router user modules are imported", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-entry-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateServerEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        null,
        null,
      );

      expect(code).toContain("export const hasMiddleware = false");
      expect(code).toMatch(
        /wrapWithRouterContext: typeof wrapWithRouterContext[\s\S]*?router: Router,/,
      );
      const globalsImportIndex = code.indexOf("/server-globals.js");
      const firstUserImportIndex = code.indexOf(
        `import * as page_0 from ${JSON.stringify(path.join(pagesDir, "index.tsx"))}`,
      );

      expect(globalsImportIndex).toBeGreaterThanOrEqual(0);
      expect(firstUserImportIndex).toBeGreaterThanOrEqual(0);
      expect(globalsImportIndex).toBeLessThan(firstUserImportIndex);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("precomputes Pages route dataKind in the server entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-data-kind-entry-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export function getStaticProps() { return { props: {} }; } export default function Page() { return null; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "ssr.tsx"),
        "export function getServerSideProps() { return { props: {} }; } export default function Page() { return null; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "plain.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateServerEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        null,
        null,
      );

      expect(code).toContain('pattern: "/",');
      expect(code).toContain('dataKind: "static"');
      expect(code).toContain('pattern: "/ssr",');
      expect(code).toContain('dataKind: "server"');
      expect(code).toContain('pattern: "/plain",');
      expect(code).toContain('dataKind: "none"');
      expect(code).not.toContain("typeof page_");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: test/e2e/no-page-props/no-page-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/no-page-props/no-page-props.test.ts
  it("uses the framework error page in server and client entries when _error is absent", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-default-error-entry-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const nextConfig = await resolveNextConfig({});
      const matcher = createValidFileMatcher();
      const serverCode = await generateServerEntry(pagesDir, nextConfig, matcher, null, null);
      const clientCode = await generateClientEntry(pagesDir, nextConfig, matcher);

      expect(serverCode).toContain('import * as ErrorPageModule from "next/error";');
      expect(clientCode).toContain('"/_error": () => import("next/error")');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: test/e2e/no-page-props/no-page-props.test.ts
  // https://github.com/vercel/next.js/blob/v16.3.0-canary.80/test/e2e/no-page-props/no-page-props.test.ts
  it("uses a custom error page in the client entry across configured page extensions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-custom-error-entry-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );
      const errorFilePath = path.join(pagesDir, "_error.page.tsx");
      fs.writeFileSync(errorFilePath, "export default function ErrorPage() { return null; }");

      const nextConfig = await resolveNextConfig({ pageExtensions: ["page.tsx", "tsx"] });
      const clientCode = await generateClientEntry(
        pagesDir,
        nextConfig,
        createValidFileMatcher(nextConfig.pageExtensions),
      );

      expect(clientCode).toContain(`"/_error": () => import(${JSON.stringify(errorFilePath)})`);
      expect(clientCode).not.toContain('"/_error": () => import("next/error")');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Refs #1474: Pages Router client entry must import the user's
  // `instrumentation-client.ts` (at the project root) as a side-effect import
  // before calling `hydrateRoot()`. Mirrors Next.js's `page-bootstrap.ts`
  // which side-effect-imports `require-instrumentation-client` ahead of
  // `initialize` / `hydrate` (see
  // .nextjs-ref/packages/next/src/client/page-bootstrap.ts line 1).
  //
  // Ported from Next.js: test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/instrumentation-client-hook/instrumentation-client-hook.test.ts
  it("imports the user's instrumentation-client.ts before calling hydrateRoot()", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-"));
    const pagesDir = path.join(tmpDir, "pages");
    const instrumentationClientPath = path.join(tmpDir, "instrumentation-client.ts");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );
      fs.writeFileSync(
        instrumentationClientPath,
        "(window as any).__INSTRUMENTATION_CLIENT_EXECUTED_AT = performance.now();",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        { instrumentationClientPath },
      );

      // The user's `instrumentation-client.ts` must be imported as a
      // side-effect import (no `from`, no `as`) so its top-level statements
      // execute when the client entry module is evaluated.
      const userImportIndex = code.indexOf(`import ${JSON.stringify(instrumentationClientPath)}`);
      const hydrateRootIndex = code.indexOf("hydrateRoot(");

      expect(userImportIndex).toBeGreaterThanOrEqual(0);
      expect(hydrateRootIndex).toBeGreaterThanOrEqual(0);
      expect(userImportIndex).toBeLessThan(hydrateRootIndex);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits the user instrumentation-client import when no file is present", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-empty-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        { instrumentationClientPath: null },
      );

      // Sanity check: the entry still wires up hydration and the hooks alias.
      expect(code).toContain("hydrateRoot(");
      expect(code).toContain("vinext/instrumentation-client");
      // No spurious bare imports referring to a non-existent project file.
      expect(code).not.toMatch(/import "[^"]*instrumentation-client\.ts"/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: test/e2e/middleware-rewrites/test/index.test.ts
  // https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/middleware-rewrites/test/index.test.ts
  it("emits only getStaticProps pages in the Pages SSG prefetch manifest", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-ssg-manifest-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "ssg.tsx"),
        "export function getStaticProps() { return { props: {} }; } export default function Page() { return null; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "dynamic.tsx"),
        "export function getServerSideProps() { return { props: {} }; } export default function Page() { return null; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "public-alias.tsx"),
        "const loader = () => ({ props: {} }); export { loader as getStaticProps }; export default function Page() { return null; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "local-alias.tsx"),
        "const getStaticProps = () => ({ props: {} }); export { getStaticProps as loader }; export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
      );

      expect(code).toContain('window.__VINEXT_PAGES_SSG_PATTERNS__ = ["/local-alias","/ssg"]');
      expect(code).toContain('window.__VINEXT_PAGES_SSP_PATTERNS__ = ["/dynamic"]');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("embeds the Pages middleware matcher in the client entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-mw-matcher-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        { middlewareMatcher: ["/ssr", { source: "/api/:path*" }] },
      );

      expect(code).toContain(
        'window.__VINEXT_MIDDLEWARE_MATCHER__ = ["/ssr",{"source":"/api/:path*"}]',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits the React preamble when the React plugin is disabled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-preamble-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        { reactPreamble: false },
      );

      expect(code).not.toContain("@vitejs/plugin-react/preamble");
      expect(code).toContain("hydrateRoot(");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("hydrates _app with the full Pages props envelope", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-props-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "_app.tsx"),
        "export default function App({ Component, pageProps }) { return <Component {...pageProps} />; }",
      );
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
      );

      expect(code).toContain(
        'const props = nextData.props && typeof nextData.props === "object" ? nextData.props : {};',
      );
      expect(code).toContain("const rawPageProps = props.pageProps;");
      expect(code).toContain(
        'const pageProps = rawPageProps && typeof rawPageProps === "object" ? rawPageProps : {};',
      );
      expect(code).toContain("import Router, {");
      expect(code).toContain("wrapWithRouterContext,");
      expect(code).toContain("_initializePagesRouterReadyFromNextData,");
      expect(code).toContain('} from "next/router";');
      expect(code).toContain("_initializePagesRouterReadyFromNextData(nextData);");
      expect(code).toContain("router: Router,");
      expect(code).toContain("pageProps: rawPageProps,");
      expect(code).toContain("element = wrapWithRouterContext(element, resolveHydrationCommit);");
      expect(code).toContain("await hydrationCommitted;");
      expect(code).toContain("if (nextData.isFallback) {");
      expect(code).toContain("const routeUrl = nextData.__vinext?.routeUrl;");
      expect(code).toContain("await Router.replace(");
      expect(code).toContain("routeUrl || currentUrl,");
      expect(code).toContain("routeUrl ? currentUrl : undefined,");
      expect(code).toContain("{ _h: 1, scroll: false },");
      expect(code).not.toContain("function VinextHydrationMarker");
      expect(code).not.toContain("React.createElement(VinextHydrationMarker");
      expect(code).toContain("hydrateRoot(container, element, hydrateRootOptions)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("gracefully skips Pages Router initialization without __NEXT_DATA__", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-no-data-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
      );
      const initializationStart = code.indexOf(
        'const nextDataElement = document.getElementById("__NEXT_DATA__");',
      );
      const initializationEnd = code.indexOf("  let hydrateRootOptions;", initializationStart);
      const initializationCode = code.slice(initializationStart, initializationEnd);
      const errors: string[] = [];
      await expect(
        vm.runInNewContext(`(async () => {${initializationCode}\n}\nawait hydrate();})()`, {
          window: {},
          document: { getElementById: () => null },
          console: { error: (message: string) => errors.push(message) },
          _initializePagesRouterReadyFromNextData: () => {
            throw new Error("router readiness must not initialize without __NEXT_DATA__");
          },
        }),
      ).resolves.toBeUndefined();
      expect(errors).toEqual(["[vinext] No __NEXT_DATA__ found"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("installs the dev error overlay before loading Pages Router modules", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-overlay-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
      );

      const overlayImportIndex = code.indexOf('await import("vinext/dev-error-overlay")');
      const pageLoadIndex = code.indexOf("const pageModule = await loader()");
      const hydrateRootIndex = code.indexOf("hydrateRoot(container, element, hydrateRootOptions)");

      expect(overlayImportIndex).toBeGreaterThanOrEqual(0);
      expect(pageLoadIndex).toBeGreaterThanOrEqual(0);
      expect(hydrateRootIndex).toBeGreaterThanOrEqual(0);
      expect(code).toContain("overlay.installDevErrorOverlay()");
      expect(code).toContain("overlay.installViteHmrErrorHandler(import.meta.hot)");
      expect(code).toContain("overlay.reportInitialDevServerErrors()");
      expect(code).toContain("onCaughtError: overlay.devOnCaughtError");
      expect(code).toContain("onUncaughtError: overlay.devOnUncaughtError");
      expect(overlayImportIndex).toBeLessThan(pageLoadIndex);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Ported from Next.js: `reactStrictMode` wraps the client tree in
  // <React.StrictMode> via the `process.env.__NEXT_STRICT_MODE` branch in
  // .nextjs-ref/packages/next/src/client/index.tsx (around line 787). vinext
  // signals this to its router shim via `window.__VINEXT_REACT_STRICT_MODE__`,
  // which `wrapWithRouterContext` reads so the wrap is applied on the initial
  // hydration AND every navigation render (Next.js's `doRender` closure runs
  // for both). For the Pages Router the default is OFF —
  // `reactStrictMode === null ? false` in
  // .nextjs-ref/packages/next/src/build/define-env.ts — so the flag is `true`
  // only when the option is explicitly `true`.
  it("publishes the reactStrictMode flag to the client entry when reactStrictMode is true", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-strict-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      const code = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({ reactStrictMode: true }),
        createValidFileMatcher(),
      );

      // The flag is set before hydrate() runs so wrapWithRouterContext sees it
      // on the very first render.
      const flagIndex = code.indexOf("window.__VINEXT_REACT_STRICT_MODE__ = true;");
      const hydrateRootIndex = code.indexOf("hydrateRoot(container, element, hydrateRootOptions)");

      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(hydrateRootIndex).toBeGreaterThanOrEqual(0);
      expect(flagIndex).toBeLessThan(hydrateRootIndex);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("publishes a false reactStrictMode flag for the Pages Router by default or when disabled", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-pages-client-entry-no-strict-"));
    const pagesDir = path.join(tmpDir, "pages");

    try {
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );

      // Unset → Pages Router default is OFF (Next.js: `reactStrictMode === null ? false`).
      const defaultCode = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
      );
      expect(defaultCode).toContain("window.__VINEXT_REACT_STRICT_MODE__ = false;");
      expect(defaultCode).not.toContain("window.__VINEXT_REACT_STRICT_MODE__ = true;");

      // Explicit false → also OFF.
      const disabledCode = await generateClientEntry(
        pagesDir,
        await resolveNextConfig({ reactStrictMode: false }),
        createValidFileMatcher(),
      );
      expect(disabledCode).toContain("window.__VINEXT_REACT_STRICT_MODE__ = false;");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
