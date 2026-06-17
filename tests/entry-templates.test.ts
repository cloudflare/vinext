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
import { generateBrowserEntry } from "../packages/vinext/src/entries/app-browser-entry.js";
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
      '{"canPrefetchLoadingShell":false,"patternParts":["modal-host"],"isDynamic":false}',
    );
    expect(code).not.toContain(
      '{"canPrefetchLoadingShell":false,"patternParts":["api"],"isDynamic":false}',
    );
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
    expect(imports.match(/\/tmp\/test\/app\/layout\.tsx/g)).toHaveLength(1);
    // All page modules are lazy loaders (including the dynamic "/dashboard/:id"
    // page and intercepting pages); only shared modules
    // (layouts/templates/boundaries) and global-error stay eager `import * as`.
    expect(imports).toContain('const load_0 = () => import("/tmp/test/app/page.tsx");');
    expect(imports).toContain(
      'const load_1 = () => import("/tmp/test/app/dashboard/[id]/page.tsx");',
    );
    expect(imports).toContain(
      'const load_2 = () => import("/tmp/test/app/dashboard/[id]/route.ts");',
    );
    expect(imports).toContain(
      'const load_3 = () => import("/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx");',
    );
    expect(imports).toContain('import * as mod_15 from "/tmp/test/app/global-error.tsx";');

    expect(manifest.rootNotFoundVar).toBe("mod_1");
    expect(manifest.rootForbiddenVar).toBe("mod_2");
    expect(manifest.rootUnauthorizedVar).toBe("mod_3");
    expect(manifest.rootLayoutVars).toEqual(["mod_0"]);
    expect(manifest.globalErrorVar).toBe("mod_15");

    const dynamicRouteEntry = manifest.routeEntries[1];
    expect(dynamicRouteEntry).toContain('"route":"route:/dashboard/:id"');
    expect(dynamicRouteEntry).toContain(
      '"modal:/tmp/test/app/dashboard/@modal":"slot:modal:/dashboard"',
    );
    expect(dynamicRouteEntry).toContain('id: "slot:modal:/dashboard"');
    expect(dynamicRouteEntry).toContain('pattern: "/dashboard/:id"');
    expect(dynamicRouteEntry).toContain("page: null");
    expect(dynamicRouteEntry).toContain("__loadPage: load_1");
    expect(dynamicRouteEntry).toContain("routeHandler: null");
    expect(dynamicRouteEntry).toContain("__loadRouteHandler: load_2");
    expect(dynamicRouteEntry).toContain("layouts: [mod_0, mod_4]");
    expect(dynamicRouteEntry).toContain('"modal:/tmp/test/app/dashboard/@modal": {');
    expect(dynamicRouteEntry).toContain("interceptLayouts: [mod_14]");
    expect(dynamicRouteEntry).toContain("page: null");
    expect(dynamicRouteEntry).toContain("__pageLoader: load_3");
    expect(dynamicRouteEntry).toContain('params: ["photoId"]');
    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/dashboard/:id": __createAppPrerenderStaticParamsResolver([{ load: load_1 }], ["id"]),',
    ]);
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

    // The "/server" page is a static route, so it is lazy-loaded (load_0) and
    // the eager `import * as mod_N` numbering starts at the root layout.
    expect(manifest.rootLayoutVars).toEqual(["mod_0"]);
    expect(manifest.rootNotFoundVar).toBe("mod_1");
    expect(manifest.rootForbiddenVar).toBe("mod_2");
    expect(manifest.rootUnauthorizedVar).toBe("mod_3");
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
      '  "/:lang/:locale": __createAppPrerenderStaticParamsResolver([mod_0?.generateStaticParams], ["lang","locale"]),',
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
      '  "/:lang/docs v2/:section": __createAppPrerenderStaticParamsResolver([mod_0?.generateStaticParams], ["lang","section"]),',
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

  it("generateRscEntry passes page-slot dynamic stale time config into App page dispatch", () => {
    // Ported from Next.js: test/e2e/app-dir/segment-cache/staleness/segment-cache-per-page-dynamic-stale-time.test.ts
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain(
      "parallelPages: Object.values(route.slots ?? {}).map((slot) => slot.page)",
    );
    expect(code).toContain("dynamicStaleTimeSeconds: __segmentConfig.dynamicStaleTimeSeconds");
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
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("const __loadGlobalNotFoundModule = null;");
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
      expect(code).toContain("return __normalizePagesDataRequest(request, buildId)");
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
      expect(code).toContain("await Router.replace(");
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
});
