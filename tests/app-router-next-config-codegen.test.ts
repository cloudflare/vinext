import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateSsrEntry } from "../packages/vinext/src/entries/app-ssr-entry.js";
import vinext from "../packages/vinext/src/index.js";

describe("App Router next.config.js features (generateRscEntry)", () => {
  // Use a minimal route list for testing — we only care about the generated config handling code
  const minimalRoutes = [
    {
      pattern: "/",
      pagePath: "/tmp/test/app/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      forbiddenPaths: [],
      forbiddenPath: null,
      unauthorizedPaths: [],
      unauthorizedPath: null,
      routeSegments: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
    },
    {
      pattern: "/about",
      pagePath: "/tmp/test/app/about/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      forbiddenPaths: [],
      forbiddenPath: null,
      unauthorizedPaths: [],
      unauthorizedPath: null,
      routeSegments: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
    },
    {
      pattern: "/blog/:slug",
      pagePath: "/tmp/test/app/blog/[slug]/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      forbiddenPaths: [],
      forbiddenPath: null,
      unauthorizedPaths: [],
      unauthorizedPath: null,
      routeSegments: [],
      layoutTreePositions: [0],
      isDynamic: true,
      params: ["slug"],
    },
  ] as any[];

  it("generates redirect handling code when redirects are provided", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      redirects: [
        { source: "/old-about", destination: "/about", permanent: true },
        { source: "/old-blog/:slug", destination: "/blog/:slug", permanent: false },
      ],
    });
    expect(code).toContain("createAppRscHandler");
    expect(code).toContain("__configRedirects");
    expect(code).toContain("configRedirects: __configRedirects");
    expect(code).toContain("/old-about");
    expect(code).toContain("/old-blog/:slug");
    expect(code).toContain("permanent");
  });

  it("generates rewrite handling code when rewrites are provided", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [{ source: "/before-rewrite", destination: "/about" }],
        afterFiles: [{ source: "/after-rewrite", destination: "/about" }],
        fallback: [{ source: "/fallback-rewrite", destination: "/about" }],
      },
    });
    expect(code).toContain("__configRewrites");
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain("beforeFiles");
    expect(code).toContain("afterFiles");
    expect(code).toContain("fallback");
    expect(code).toContain("/before-rewrite");
    expect(code).toContain("/after-rewrite");
    expect(code).toContain("/fallback-rewrite");
  });

  it("generates custom header handling code when headers are provided", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      headers: [{ source: "/api/(.*)", headers: [{ key: "X-Custom-Header", value: "vinext" }] }],
    });
    expect(code).toContain("__configHeaders");
    expect(code).toContain("configHeaders: __configHeaders");
    expect(code).toContain("X-Custom-Header");
    expect(code).toContain("vinext");
  });

  it("embeds image validation config in the pure App Router RSC handler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      imageConfig: {
        deviceSizes: [320, 640],
        imageSizes: [16],
        qualities: [60, 75],
      },
    });
    expect(code).toContain("const __imageConfig");
    expect(code).toContain('"deviceSizes":[320,640]');
    expect(code).toContain('"qualities":[60,75]');
    expect(code).toContain("imageConfig: __imageConfig");
    expect(code).toContain('isDev: process.env.NODE_ENV !== "production"');
  });

  it("routes hybrid Pages API misses through the Pages server entry", () => {
    // Ported from Next.js: test/e2e/og-api/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/og-api/index.test.ts
    //
    // In a mixed app/ + pages/ project, a Pages Router API route such as
    // pages/api/og.js remains a real route even though the production server
    // enters through the App Router handler.
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      hasPagesDir: true,
    });

    expect(code).toContain("renderPagesFallback as __renderPagesFallback");
    expect(code).toContain("server/app-pages-bridge.js");
    expect(code).toContain("return __renderPagesFallback(");
    expect(code).toContain("pagesDataRequest");
    expect(code).toContain('return import.meta.viteRsc.loadModule("ssr", "index");');
    expect(code).toContain("buildId: process.env.__VINEXT_BUILD_ID ?? null");
    expect(code).toContain("buildRequestHeaders: __buildRequestHeadersFromMiddlewareResponse");
    expect(code).toContain(
      "applyRouteHandlerMiddlewareContext: __applyRouteHandlerMiddlewareContext",
    );
  });

  it("exports whether the App Router build includes Pages Router routes", () => {
    const appOnlyCode = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false);
    const hybridCode = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      hasPagesDir: true,
    });

    expect(appOnlyCode).toContain("export const __hasPagesDir = false;");
    expect(hybridCode).toContain("export const __hasPagesDir = true;");
  });

  it("re-exports Pages API handling from the hybrid SSR entry", () => {
    // Ported from Next.js: test/e2e/og-api/index.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/og-api/index.test.ts
    //
    // The production App Router entry loads the SSR environment's "index"
    // module for Pages fallbacks. That bridge must expose the Pages API
    // dispatcher as well as page rendering.
    const code = generateSsrEntry(true);

    expect(code).toContain("handleApiRoute, matchApiRoute, matchPageRoute, pageRoutes, renderPage");
  });

  it("embeds basePath and trailingSlash alongside config", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "/app", true, {
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
    });
    // User-provided basePath and trailingSlash must flow through into the
    // generated entry alongside redirect config.
    expect(code).toContain('"/app"');
    expect(code).toContain("/old");
  });

  it("includes config pattern matching function for regex patterns", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      redirects: [{ source: "/docs/:path*", destination: "/wiki/:path*", permanent: false }],
    });
    expect(code).toContain("configRedirects: __configRedirects");
    expect(code).toContain(":path*");
  });

  it("delegates request lifecycle to the typed App RSC handler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
    });
    expect(code).toContain("export default createAppRscHandler({");
    expect(code).toContain("configRedirects: __configRedirects");
    expect(code).toContain("dispatchMatchedPage({");
    expect(code).toContain("    clientReuseManifest,");
    expect(code).toContain("    rootParams,\n    request,");
    expect(code).toContain("      clientReuseManifest,");
    expect(code).toContain("      rootParams,\n      probeLayoutAt");
    expect(code).toContain("dispatchMatchedRouteHandler({");
    expect(code).toContain("matchRoute,");
  });

  it("describes beforeFiles rewrites in the generated app shape", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [{ source: "/old", destination: "/new" }],
        afterFiles: [],
        fallback: [],
      },
    });
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain('"beforeFiles":[{"source":"/old","destination":"/new"}]');
  });

  it("passes the typed handler the generated route matcher and config", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [{ source: "/old", destination: "/new" }],
        afterFiles: [],
        fallback: [],
      },
    });
    expect(code).toContain("const __routeMatcher = __createAppRscRouteMatcher(routes);");
    expect(code).toContain("matchRoute,");
    expect(code).toContain("configRewrites: __configRewrites");
  });

  it("describes afterFiles rewrites in the generated app shape", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/old", destination: "/new" }],
        fallback: [],
      },
    });
    expect(code).toContain('"afterFiles":[{"source":"/old","destination":"/new"}]');
    expect(code).toContain("configRewrites: __configRewrites");
  });

  it("applies fallback rewrites when no route matches", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [{ source: "/fallback", destination: "/about" }],
      },
    });
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain('"fallback":[{"source":"/fallback","destination":"/about"}]');
  });

  it("describes external beforeFiles rewrites in the generated config", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [{ source: "/ph/:path*", destination: "https://us.i.posthog.com/:path*" }],
        afterFiles: [],
        fallback: [],
      },
    });
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain("https://us.i.posthog.com/:path*");
  });

  it("describes external afterFiles rewrites in the generated config", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/api/:path*", destination: "https://api.example.com/:path*" }],
        fallback: [],
      },
    });
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain("https://api.example.com/:path*");
  });

  it("describes external fallback rewrites in the generated config", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [],
        afterFiles: [],
        fallback: [
          { source: "/fallback/:path*", destination: "https://fallback.example.com/:path*" },
        ],
      },
    });
    expect(code).toContain("configRewrites: __configRewrites");
    expect(code).toContain("https://fallback.example.com/:path*");
  });

  it("passes basePath and redirect config to the generated handler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "/app", false, {
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
    });
    expect(code).toContain('const __basePath = "/app"');
    expect(code).toContain("basePath: __basePath");
    expect(code).toContain("configRedirects: __configRedirects");
  });

  it("passes server action handlers and afterFiles rewrites to the typed handler", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      rewrites: {
        beforeFiles: [],
        afterFiles: [{ source: "/x", destination: "/y" }],
        fallback: [],
      },
    });
    expect(code).toContain("handleServerActionRequest({");
    expect(code).toContain("loadServerAction");
    expect(code).toContain('"afterFiles":[{"source":"/x","destination":"/y"}]');
    expect(code).toContain("configRewrites: __configRewrites");
  });

  it("embeds allowedOrigins when provided", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      allowedOrigins: ["my-proxy.com", "*.my-domain.com"],
    });
    expect(code).toContain("__allowedOrigins");
    expect(code).toContain("my-proxy.com");
    expect(code).toContain("*.my-domain.com");
  });

  it("keeps allowedDevOrigins separate from allowedOrigins", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      allowedOrigins: ["actions.example.com"],
      allowedDevOrigins: ["allowed.example.com"],
    });
    expect(code).toContain("actions.example.com");
    expect(code).toContain("allowed.example.com");
  });

  it("origin validation does not use x-forwarded-host", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false);
    const actionStart = code.indexOf("handleServerActionRequest({");
    const actionEnd = code.indexOf("i18nConfig: __i18nConfig", actionStart);
    const actionOptions = code.slice(actionStart, actionEnd);

    // CSRF behavior belongs to the shared action helper. The generated entry
    // should only pass the original Request and configured origins through.
    expect(actionOptions).toContain("request,");
    expect(actionOptions).toContain("allowedOrigins: __allowedOrigins");
    expect(actionOptions).not.toContain("x-forwarded-host");
    expect(code).not.toContain("validateCsrfOrigin(request, __allowedOrigins)");
    expect(code).not.toContain("function __validateCsrfOrigin");
  });

  // ── Dev origin check code generation ────────────────────────────────
  it("generates dev origin validation code in RSC entry", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false);
    // Should include the dev origin validation function definition
    expect(code).toContain("__validateDevRequestOrigin");
    expect(code).toContain("__safeDevHosts");
    expect(code).toContain("validateDevRequestOrigin: __validateDevRequestOrigin");
  });

  it("embeds allowedDevOrigins in dev origin check code", () => {
    const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false, {
      allowedDevOrigins: ["staging.example.com", "*.preview.dev"],
    });
    expect(code).toContain("staging.example.com");
    expect(code).toContain("*.preview.dev");
    expect(code).toContain("__allowedDevOrigins");
  });

  it("loads allowedDevOrigins from next.config into the virtual RSC entry", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-app-rsc-allowed-dev-origins-"));
    try {
      fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "app", "layout.tsx"),
        "export default function Layout({ children }) { return <html><body>{children}</body></html>; }",
      );
      fs.writeFileSync(
        path.join(tmpDir, "app", "page.tsx"),
        "export default function Page() { return <div>allowed-dev-origins</div>; }",
      );
      fs.writeFileSync(
        path.join(tmpDir, "next.config.mjs"),
        `export default {
  allowedDevOrigins: ["allowed.example.com"],
  experimental: {
    serverActions: {
      allowedOrigins: ["actions.example.com"],
    },
  },
};`,
      );
      fs.symlinkSync(
        path.resolve(__dirname, "..", "node_modules"),
        path.join(tmpDir, "node_modules"),
        "junction",
      );

      const testServer = await createServer({
        root: tmpDir,
        configFile: false,
        plugins: [vinext({ appDir: tmpDir })],
        server: { port: 0 },
        logLevel: "silent",
      });

      try {
        const resolved = await testServer.pluginContainer.resolveId("virtual:vinext-rsc-entry");
        expect(resolved).toBeTruthy();
        const loaded = await testServer.pluginContainer.load(resolved!.id);
        const code = typeof loaded === "string" ? loaded : ((loaded as any)?.code ?? "");

        expect(code).toContain('const __allowedDevOrigins = ["allowed.example.com"]');
        expect(code).toContain('const __allowedOrigins = ["actions.example.com"]');
      } finally {
        await testServer.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("RSC error runtime delegation", () => {
    it("imports RSC error helpers from a normal server module", () => {
      const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false);

      expect(code).toContain("sanitizeErrorForClient as __sanitizeErrorForClient");
      expect(code).toContain("server/app-rsc-errors.js");
      expect(code).toContain("createAppRscOnErrorHandler");
      expect(code).toContain("server/app-rsc-error-handler.js");
    });

    it("keeps request-specific onError wiring in the generated entry", () => {
      const code = generateRscEntry("/tmp/test/app", minimalRoutes, null, [], null, "", false);

      expect(code).toContain("createRscOnErrorHandler(pathname, routePath)");
      expect(code).toContain(
        "createAppRscOnErrorHandler(_reportRequestError, request, pathname, routePath)",
      );
      expect(code).not.toContain("function createRscOnErrorHandler(request, pathname, routePath)");
      expect(code).not.toContain("return __createRscOnErrorHandler({");
    });
  });
});
