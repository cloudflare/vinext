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
import { describe, it, expect, afterAll } from "vitest";
import { createServer, type ViteDevServer } from "vite";
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
