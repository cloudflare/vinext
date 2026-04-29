/**
 * Snapshot tests for the entry template code generators.
 *
 * These tests lock down the exact generated code for all virtual entry modules
 * so that future refactoring (extracting generators into separate files, etc.)
 * can be verified against a known baseline.
 *
 * - App Router generators are standalone exported functions → imported directly.
 * - Pages Router generators are closures inside the plugin → tested via
 *   Vite's pluginContainer.load() on the virtual module IDs.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { describe, it, expect, afterAll } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
import { buildAppRscManifestCode } from "../packages/vinext/src/entries/app-rsc-manifest.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import type { AppRouterConfig } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateSsrEntry } from "../packages/vinext/src/entries/app-ssr-entry.js";
import { generateBrowserEntry } from "../packages/vinext/src/entries/app-browser-entry.js";
import type { AppRoute } from "../packages/vinext/src/routing/app-router.js";
import type { MetadataFileRoute } from "../packages/vinext/src/server/metadata-routes.js";
import vinext from "../packages/vinext/src/index.js";

// Workspace root (forward-slash normalised) used to replace absolute paths
// in generated code so snapshots are machine-independent.
const ROOT = path.resolve(import.meta.dirname, "..").replace(/\\/g, "/");

/** Replace all occurrences of the workspace root with `<ROOT>`. */
function stabilize(code: string): string {
  return code.replaceAll(ROOT, "<ROOT>");
}

// ── Minimal App Router route fixtures ─────────────────────────────────
// Use stable absolute paths so snapshots don't depend on the machine.
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
  },
];

// ── Pages Router fixture ──────────────────────────────────────────────
// NOTE: Adding, removing, or renaming pages in this fixture will break the
// Pages Router snapshots below. Run `pnpm test tests/entry-templates.test.ts -u`
// to update them after intentional fixture changes.
const PAGES_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/pages-basic");

// ── App Router manifest construction ─────────────────────────────────

describe("App Router generated manifest construction", () => {
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
      },
      {
        pattern: "/dashboard/:id",
        patternParts: ["dashboard", ":id"],
        pagePath: "/tmp/test/app/dashboard/[id]/page.tsx",
        routePath: "/tmp/test/app/dashboard/[id]/route.ts",
        layouts: ["/tmp/test/app/layout.tsx", "/tmp/test/app/dashboard/layout.tsx"],
        templates: ["/tmp/test/app/dashboard/template.tsx"],
        parallelSlots: [
          {
            key: "modal:/tmp/test/app/dashboard/@modal",
            name: "modal",
            ownerDir: "/tmp/test/app/dashboard/@modal",
            pagePath: "/tmp/test/app/dashboard/@modal/page.tsx",
            defaultPath: "/tmp/test/app/dashboard/@modal/default.tsx",
            layoutPath: "/tmp/test/app/dashboard/@modal/layout.tsx",
            loadingPath: "/tmp/test/app/dashboard/@modal/loading.tsx",
            errorPath: "/tmp/test/app/dashboard/@modal/error.tsx",
            interceptingRoutes: [
              {
                convention: ".",
                targetPattern: "/photos/:photoId",
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
      },
    ] satisfies AppRoute[];

    const manifest = buildAppRscManifestCode({
      routes,
      metadataRoutes: [],
      globalErrorPath: "/tmp/test/app/global-error.tsx",
    });

    const imports = manifest.imports.join("\n");
    expect(imports.match(/\/tmp\/test\/app\/layout\.tsx/g)).toHaveLength(1);
    expect(imports).toContain('import * as mod_0 from "/tmp/test/app/page.tsx";');
    expect(imports).toContain(
      'import * as mod_17 from "/tmp/test/app/dashboard/@modal/(.)photos/[photoId]/page.tsx";',
    );
    expect(imports).toContain('import * as mod_19 from "/tmp/test/app/global-error.tsx";');

    expect(manifest.rootNotFoundVar).toBe("mod_2");
    expect(manifest.rootForbiddenVar).toBe("mod_3");
    expect(manifest.rootUnauthorizedVar).toBe("mod_4");
    expect(manifest.rootLayoutVars).toEqual(["mod_1"]);
    expect(manifest.globalErrorVar).toBe("mod_19");

    const dynamicRouteEntry = manifest.routeEntries[1];
    expect(dynamicRouteEntry).toContain('pattern: "/dashboard/:id"');
    expect(dynamicRouteEntry).toContain("routeHandler: mod_6");
    expect(dynamicRouteEntry).toContain("layouts: [mod_1, mod_7]");
    expect(dynamicRouteEntry).toContain('"modal:/tmp/test/app/dashboard/@modal": {');
    expect(dynamicRouteEntry).toContain("interceptLayouts: [mod_18]");
    expect(dynamicRouteEntry).toContain("page: mod_17");
    expect(dynamicRouteEntry).toContain('params: ["photoId"]');
    expect(manifest.generateStaticParamsEntries).toEqual([
      '  "/dashboard/:id": mod_5?.generateStaticParams ?? null,',
    ]);
  });

  it("embeds static metadata files and imports dynamic metadata modules", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-manifest-"));
    try {
      const staticManifestPath = path.join(tmpDir, "manifest.webmanifest");
      fs.writeFileSync(staticManifestPath, '{"name":"Vinext"}');

      const manifest = buildAppRscManifestCode({
        routes: minimalAppRoutes,
        metadataRoutes: [
          {
            type: "manifest",
            isDynamic: false,
            filePath: staticManifestPath,
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
          {
            type: "opengraph-image",
            isDynamic: true,
            filePath: "/tmp/test/app/blog/[slug]/opengraph-image.tsx",
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
            servedUrl: "/manifest.webmanifest",
            contentType: "application/manifest+json",
          },
        ],
        globalErrorPath: null,
      }),
    ).toThrow("[vinext] Failed to read static metadata route file");
  });
});

// ── App Router entry templates ────────────────────────────────────────

describe("App Router entry templates", () => {
  it("generateRscEntry snapshot (minimal routes)", () => {
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null, // no middleware
      [], // no metadata routes
      null, // no global error
      "", // no basePath
      false, // no trailingSlash
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry snapshot (with middleware)", () => {
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      "/tmp/test/middleware.ts",
      [],
      null,
      "",
      false,
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry snapshot (with instrumentation)", () => {
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      null,
      "",
      false,
      undefined,
      "/tmp/test/instrumentation.ts",
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry snapshot (with global error)", () => {
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      "/tmp/test/app/global-error.tsx",
      "",
      false,
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry snapshot (with config)", () => {
    const config: AppRouterConfig = {
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      rewrites: {
        beforeFiles: [{ source: "/api/:path*", destination: "/backend/:path*" }],
        afterFiles: [],
        fallback: [],
      },
      headers: [
        {
          source: "/api/:path*",
          headers: [{ key: "X-Custom", value: "test" }],
        },
      ],
      allowedOrigins: ["https://example.com"],
      allowedDevOrigins: ["localhost:3001"],
    };
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      [],
      null,
      "/base",
      true,
      config,
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry snapshot (with metadata routes)", () => {
    const metadataRoutes: MetadataFileRoute[] = [
      {
        type: "sitemap",
        isDynamic: true,
        filePath: "/tmp/test/app/sitemap.ts",
        servedUrl: "/sitemap.xml",
        contentType: "application/xml",
      },
    ];
    const code = generateRscEntry(
      "/tmp/test/app",
      minimalAppRoutes,
      null,
      metadataRoutes,
      null,
      "",
      false,
    );
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateRscEntry delegates route matching to the shared helper", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);
    const stableCode = stabilize(code);

    expect(stableCode).toContain(
      'from "<ROOT>/packages/vinext/src/server/app-rsc-route-matching.js";',
    );
    expect(code).toContain("const __routeMatcher = __createAppRscRouteMatcher(routes);");
    expect(code).toContain("return __routeMatcher.matchRoute(url);");
    expect(code).toContain("return __routeMatcher.findIntercept(pathname, sourcePathname);");
    expect(code).not.toContain("const interceptLookup = [];");
    expect(code).not.toContain("function mergeMatchedParams(");
  });

  it("generateRscEntry wires buildPageElements into the server-action helper", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);
    const actionStart = code.indexOf("const serverActionResponse");
    const actionEnd = code.indexOf("if (serverActionResponse)", actionStart);
    const helperOptions = code.slice(actionStart, actionEnd);

    expect(helperOptions).toContain("buildPageElement({");
    expect(helperOptions).toContain("return buildPageElements(actionRoute, actionParams");
  });

  it("generateRscEntry delegates server action flow to the shared helper", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("handleServerActionRscRequest as __handleServerActionRscRequest");
    expect(code).toContain("const serverActionResponse = await __handleServerActionRscRequest({");
    expect(code).not.toContain("const __actionRerenderTarget =");
  });

  it("generateRscEntry reuses the canonical tree-path helper for no-export page payloads", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("createAppPageTreePath as __createAppPageTreePath");
    expect(code).toContain(
      "_noExportRootLayout = __createAppPageTreePath(route.routeSegments, _tp);",
    );
  });

  it("generateRscEntry delegates React Flight preload hint normalization", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain(
      "normalizeReactFlightPreloadHints as __normalizeReactFlightPreloadHints",
    );
    expect(code).toContain("return __normalizeReactFlightPreloadHints(_renderToReadableStream");
    expect(code).not.toContain("const _hlFixRe =");
  });

  it("generateRscEntry delegates internal prerender endpoints", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false, {
      hasPagesDir: true,
    });
    const stableCode = stabilize(code);

    expect(stableCode).toContain(
      'from "<ROOT>/packages/vinext/src/server/app-prerender-endpoints.js";',
    );
    expect(code).toContain("handleAppPrerenderEndpoint as __handleAppPrerenderEndpoint");
    expect(code).toContain(
      "const __prerenderEndpointResponse = await __handleAppPrerenderEndpoint(",
    );
    expect(code).toContain("loadPagesRoutes: __loadPrerenderPagesRoutes,");
    expect(code).not.toContain('if (pathname === "/__vinext/prerender/static-params")');
    expect(code).not.toContain('if (pathname === "/__vinext/prerender/pages-static-paths")');
  });

  it("generateSsrEntry snapshot", () => {
    const code = generateSsrEntry();
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("generateBrowserEntry snapshot", () => {
    const code = generateBrowserEntry();
    expect(stabilize(code)).toMatchSnapshot();
  });
});

// ── Pages Router entry templates ──────────────────────────────────────
// These are closure functions inside the vinext() plugin, so we test
// them via Vite's pluginContainer.load() on the virtual module IDs.

describe("Pages Router entry templates", () => {
  let server: ViteDevServer;

  afterAll(async () => {
    if (server) await server.close();
  });

  async function getVirtualModuleCode(moduleId: string): Promise<string> {
    if (!server) {
      server = await createServer({
        root: PAGES_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext()],
        server: { port: 0 },
        logLevel: "silent",
      });
    }
    const resolved = await server.pluginContainer.resolveId(moduleId);
    expect(resolved).toBeTruthy();
    const loaded = await server.pluginContainer.load(resolved!.id);
    expect(loaded).toBeTruthy();
    return typeof loaded === "string"
      ? loaded
      : typeof loaded === "object" && loaded !== null && "code" in loaded
        ? loaded.code
        : "";
  }

  it("server entry snapshot", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    expect(stabilize(code)).toMatchSnapshot();
  });

  it("server entry uses trie-based route matching", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    expect(stabilize(code)).toContain("buildRouteTrie");
    expect(stabilize(code)).toContain("trieMatch");
  });

  it("server entry delegates Pages ISR cache plumbing to shared helpers", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    const stableCode = stabilize(code);

    expect(stableCode).toContain('from "<ROOT>/packages/vinext/src/server/isr-cache.js";');
    expect(code).toContain("function isrGet(key) {");
    expect(code).toContain("return __sharedIsrGet(key);");
    expect(code).toContain(
      "return __sharedTriggerBackgroundRegeneration(key, renderFn, errorContext);",
    );
    expect(code).not.toContain("const promise = renderFn()");
    expect(code).not.toContain("ctx.waitUntil(promise)");
  });

  it("server entry seeds the main Pages Router unified context with executionContext", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    const renderPageIndex = code.indexOf(
      "async function _renderPage(request, url, manifest, middlewareHeaders) {",
    );
    const unifiedCtxIndex = code.indexOf("const __uCtx = _createUnifiedCtx({", renderPageIndex);

    expect(renderPageIndex).toBeGreaterThan(-1);
    expect(unifiedCtxIndex).toBeGreaterThan(renderPageIndex);

    const renderPageSection = code.slice(unifiedCtxIndex, unifiedCtxIndex + 200);
    expect(renderPageSection).toContain("executionContext: _getRequestExecutionContext(),");
  });

  it("server entry passes a fresh unified-context ISR runner into the typed page-data helper", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    const runnerIndex = code.indexOf("runInFreshUnifiedContext(callback) {");

    expect(runnerIndex).toBeGreaterThan(-1);

    const runnerSection = code.slice(runnerIndex, runnerIndex + 500);
    expect(runnerSection).toContain("_createUnifiedCtx");
    expect(runnerSection).toContain("executionContext: _getRequestExecutionContext()");
    expect(runnerSection).toContain("_runWithUnifiedCtx");
    expect(runnerSection).toContain("ensureFetchPatch();");
    expect(runnerSection).toContain("return callback();");
  });

  it("server entry delegates Pages HTML stream/response shaping to a typed helper", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");

    expect(code).toContain("renderPagesPageResponse as __renderPagesPageResponse");
    expect(code).toContain("return __renderPagesPageResponse({");
    expect(code).not.toContain('var BODY_MARKER = "<!--VINEXT_STREAM_BODY-->";');
    expect(code).not.toContain("var compositeStream = new ReadableStream({");
  });

  it("server entry delegates Pages data/ISR handling to a typed helper", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");

    expect(code).toContain("resolvePagesPageData as __resolvePagesPageData");
    expect(code).toContain("isrGet as __sharedIsrGet");
    expect(code).toContain("isrSet as __sharedIsrSet");
    expect(code).toContain("isrCacheKey as __sharedIsrCacheKey");
    expect(code).toContain(
      "triggerBackgroundRegeneration as __sharedTriggerBackgroundRegeneration",
    );
    expect(code).toContain("const pageDataResult = await __resolvePagesPageData({");
    expect(code).toContain(
      "return __sharedTriggerBackgroundRegeneration(key, renderFn, errorContext);",
    );
    expect(code).not.toContain("async function isrGet(key)");
    expect(code).not.toContain("async function isrSet(key, data, revalidateSeconds, tags)");
    expect(code).not.toContain("const pendingRegenerations = new Map();");
    expect(code).not.toContain("function fnv1a64(input)");
    expect(code).not.toContain("const result = await pageModule.getServerSideProps(ctx);");
    expect(code).not.toContain("const result = await pageModule.getStaticProps(ctx);");
  });

  it("server entry delegates Pages API route handling and req/res shims to typed helpers", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");

    expect(code).toContain("createPagesReqRes as __createPagesReqRes");
    expect(code).toContain("handlePagesApiRoute as __handlePagesApiRoute");
    expect(code).toContain("return __handlePagesApiRoute({");
    expect(code).not.toContain("function createReqRes(request, url, query, body)");
    expect(code).not.toContain("async function readBodyWithLimit(request, maxBytes)");
    expect(code).not.toContain(
      "const { req, res, responsePromise } = createReqRes(request, url, query, body);",
    );
  });

  it("server entry isolates the ISR cache-fill rerender in fresh render sub-scopes", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");

    expect(code).toContain("async function renderIsrPassToStringAsync(element)");
    expect(code).toContain("runWithServerInsertedHTMLState(() =>");
    expect(code).toContain("runWithHeadState(() =>");
    expect(code).toContain("_runWithCacheState(() =>");
    expect(code).toContain(
      "runWithPrivateCache(() => runWithFetchCache(async () => renderToStringAsync(element)))",
    );
    expect(code).toContain("renderIsrPassToStringAsync,");
  });

  it("server entry registers i18n state without wrapping the unified request scope", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");

    expect(code).toContain('import "vinext/i18n-state";');
    expect(code).not.toContain("return runWithI18nState(() =>");
  });

  it("server entry calls reportRequestError for SSR and API errors", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-server-entry");
    // The generated prod entry must import reportRequestError
    expect(code).toContain("reportRequestError");
    // SSR page render catch block should report with routeType "render"
    expect(code).toContain('"render"');
    // API route catch block should report with routeType "route"
    expect(code).toContain('"route"');
  });

  it("client entry snapshot", async () => {
    const code = await getVirtualModuleCode("virtual:vinext-client-entry");
    expect(stabilize(code)).toMatchSnapshot();
  });
});
