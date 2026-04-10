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
import { describe, it, expect, afterAll } from "vite-plus/test";
import { createServer, type ViteDevServer } from "vite-plus";
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
    forbiddenPath: null,
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
    forbiddenPath: null,
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
    forbiddenPath: null,
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
    forbiddenPath: null,
    unauthorizedPath: null,
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

  it("generateRscEntry uses buildPageElements in the server-action re-render path", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);
    // PR 2c returns the flat elements payload instead of the monolithic page
    // element, so the action re-render path should rebuild the keyed map.
    const actionRerenderIdx = code.indexOf(
      "// After the action, re-render the current page so the client",
    );
    expect(actionRerenderIdx).toBeGreaterThan(-1);
    const rerenderSlice = code.slice(actionRerenderIdx, actionRerenderIdx + 700);
    expect(rerenderSlice).toContain("element = buildPageElements(");
  });

  it("generateRscEntry reuses the canonical tree-path helper for no-export page payloads", () => {
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);

    expect(code).toContain("createAppPageTreePath as __createAppPageTreePath");
    expect(code).toContain(
      "_noExportRootLayout = __createAppPageTreePath(route.routeSegments, _tp);",
    );
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
    expect(code).toContain("return __sharedTriggerBackgroundRegeneration(key, renderFn);");
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
    expect(code).toContain("return __sharedTriggerBackgroundRegeneration(key, renderFn);");
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
