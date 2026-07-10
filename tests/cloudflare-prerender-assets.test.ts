import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveNextConfig,
  type ResolvedNextConfig,
} from "../packages/vinext/src/config/next-config.js";
import { publishCloudflarePrerenderedAppAssets } from "../packages/vinext/src/build/cloudflare-prerender-assets.js";
import {
  writePrerenderIndex,
  type PrerenderRouteResult,
} from "../packages/vinext/src/build/prerender.js";
import {
  createRscTransportAssetPathname,
  resolveRscTransportRequest,
  VINEXT_STATIC_RSC_TRANSPORT_PREFIX,
  VINEXT_WORKER_RSC_TRANSPORT_PREFIX,
} from "../packages/vinext/src/server/app-rsc-transport.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cf-prerender-assets-"));
  tempRoots.push(root);
  return root;
}

function writeFile(filePath: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

async function baseConfig(
  overrides: Partial<ResolvedNextConfig> = {},
): Promise<ResolvedNextConfig> {
  const config = await resolveNextConfig({});
  return {
    ...config,
    basePath: "",
    deploymentId: "deploy-test",
    headers: [],
    i18n: null,
    redirects: [],
    rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
    trailingSlash: false,
    ...overrides,
  };
}

function writeWrangler(serverDir: string): void {
  writeFile(
    path.join(serverDir, "wrangler.json"),
    JSON.stringify({
      main: "index.js",
      assets: {
        binding: "ASSETS",
        directory: "../client",
        not_found_handling: "none",
      },
    }),
  );
}

function renderedAppRoute(
  route: string,
  outputFiles: string[],
  extra: Partial<Extract<PrerenderRouteResult, { status: "rendered" }>> = {},
): Extract<PrerenderRouteResult, { status: "rendered" }> {
  return {
    route,
    status: "rendered",
    outputFiles,
    queryInvariant: { html: true, rsc: true },
    revalidate: false,
    router: "app",
    ...extra,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function staticRscAssetPath(routePathname: string): string {
  return `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}${createRscTransportAssetPathname(routePathname)}`;
}

describe("publishCloudflarePrerenderedAppAssets", () => {
  it("publishes static App Router HTML at visible paths and RSC in the transport namespace", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(
      path.join(clientDir, "_headers"),
      "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n",
    );
    writeFile(path.join(prerenderDir, "index.html"), "<h1>Home</h1>");
    writeFile(path.join(prerenderDir, "index.rsc"), "home-rsc");
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");
    writeFile(path.join(prerenderDir, "isr.html"), "<h1>ISR</h1>");
    writeFile(path.join(prerenderDir, "404.html"), "<h1>Missing</h1>");
    writeFile(path.join(prerenderDir, "taken.html"), "<h1>Route</h1>");
    writeFile(path.join(prerenderDir, "taken.rsc"), "route-rsc");
    writeFile(path.join(clientDir, "taken"), "<h1>Existing asset</h1>");
    writeFile(path.join(prerenderDir, "pages-home.html"), "<h1>Pages</h1>");
    writeFile(path.join(prerenderDir, "api/static-hello"), '{"ok":true}');

    const result = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [
        renderedAppRoute("/", ["index.html", "index.rsc"]),
        renderedAppRoute("/about", ["about.html", "about.rsc"], {
          headers: { link: "</_next/static/about.css>; rel=preload" },
        }),
        renderedAppRoute("/isr", ["isr.html"], { revalidate: 60 }),
        renderedAppRoute("/404", ["404.html"]),
        renderedAppRoute("/taken", ["taken.html", "taken.rsc"]),
        renderedAppRoute("/api/static-hello", ["api/static-hello"], {
          appRouteKind: "route-handler",
          headers: { "content-type": "application/json" },
        }),
        {
          route: "/pages-home",
          status: "rendered",
          outputFiles: ["pages-home.html"],
          revalidate: false,
          router: "pages",
        },
      ],
      rscCompatibilityId: "rsc-compat-test",
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 5, publishedRoutes: 3 });
    expect(fs.readFileSync(path.join(clientDir, "index.html"), "utf-8")).toBe("<h1>Home</h1>");
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("<h1>About</h1>");
    expect(fs.existsSync(path.join(clientDir, "about.rsc"))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, "api/static-hello"), "utf-8")).toBe('{"ok":true}');
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/")}`), "utf-8")).toBe(
      "home-rsc",
    );
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "about-rsc",
    );
    expect(fs.existsSync(path.join(clientDir, "isr"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "404"))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, "taken"), "utf-8")).toBe("<h1>Existing asset</h1>");
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/taken")}`))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "pages-home"))).toBe(false);

    const headers = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(headers).toContain("/_next/static/*");
    expect(headers).toContain("/\n  Content-Type: text/html; charset=utf-8");
    expect(headers).toContain("/about\n  Content-Type: text/html; charset=utf-8");
    expect(headers).toContain("  X-Vinext-Cache: STATIC");
    expect(headers).toContain("  x-nextjs-cache: HIT");
    expect(headers).toContain("  Link: </_next/static/about.css>; rel=preload");
    expect(headers).toContain(`${staticRscAssetPath("/about")}\n  Content-Type: text/x-component`);
    expect(headers).toContain("  X-Vinext-RSC-Compatibility-Id: rsc-compat-test");
    expect(headers).toContain("  x-deployment-id: deploy-test");
    expect(headers).toContain("/api/static-hello\n  Content-Type: application/json");
  });

  it("does not publish when middleware or config request transforms are present", async () => {
    const middlewareRoot = createTempRoot();
    const middlewareServerDir = path.join(middlewareRoot, "dist/server");
    const middlewarePrerenderDir = path.join(middlewareServerDir, "prerendered-routes");
    writeWrangler(middlewareServerDir);
    writeFile(path.join(middlewareRoot, "middleware.ts"), "export function middleware() {}\n");
    writeFile(path.join(middlewarePrerenderDir, "about.html"), "<h1>About</h1>");

    const middlewareResult = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig(),
      prerenderDir: middlewarePrerenderDir,
      root: middlewareRoot,
      routes: [renderedAppRoute("/about", ["about.html"])],
      serverDir: middlewareServerDir,
    });

    expect(middlewareResult).toMatchObject({ skipped: true, publishedFiles: 0 });
    expect(fs.existsSync(path.join(middlewareRoot, "dist/client/about"))).toBe(false);

    const headersRoot = createTempRoot();
    const headersServerDir = path.join(headersRoot, "dist/server");
    const headersPrerenderDir = path.join(headersServerDir, "prerendered-routes");
    writeWrangler(headersServerDir);
    writeFile(path.join(headersPrerenderDir, "about.html"), "<h1>About</h1>");

    const headersResult = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig({
        headers: [{ source: "/about", headers: [{ key: "x-test", value: "1" }] }],
      }),
      prerenderDir: headersPrerenderDir,
      root: headersRoot,
      routes: [renderedAppRoute("/about", ["about.html"])],
      serverDir: headersServerDir,
    });

    expect(headersResult).toMatchObject({ skipped: true, publishedFiles: 0 });
    expect(fs.existsSync(path.join(headersRoot, "dist/client/about"))).toBe(false);
  });

  it("requires query-invariant prerender proof before publishing assets", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [
        renderedAppRoute("/about", ["about.html", "about.rsc"], {
          queryInvariant: undefined,
        }),
      ],
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 0, publishedRoutes: 0 });
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "about.rsc"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, "_headers"))).toBe(false);
  });

  it("maps static and Worker RSC transport requests back to visible routes", () => {
    const staticRequest = resolveRscTransportRequest(
      new Request(`https://example.test${staticRscAssetPath("/about")}?tab=1&_rsc`, {
        headers: { RSC: "1" },
      }),
    );
    expect(new URL(staticRequest.url).pathname).toBe("/about");
    expect(new URL(staticRequest.url).search).toBe("?tab=1&_rsc");

    const workerRequest = resolveRscTransportRequest(
      new Request(`https://example.test${VINEXT_WORKER_RSC_TRANSPORT_PREFIX}/docs/__index.rsc`, {
        headers: { RSC: "1" },
      }),
    );
    expect(new URL(workerRequest.url).pathname).toBe("/docs/");
  });

  it("publishes HTML without static RSC when only the HTML query-invariance proof is present", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [
        renderedAppRoute("/about", ["about.html", "about.rsc"], {
          queryInvariant: { html: true, rsc: false },
        }),
      ],
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 1, publishedRoutes: 1 });
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("<h1>About</h1>");
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(false);
  });

  it("skips HTML publication when the reserved RSC transport target already exists", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");
    writeFile(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "existing-rsc-asset");

    const result = publishCloudflarePrerenderedAppAssets({
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [
        renderedAppRoute("/about", ["about.html", "about.rsc"], {
          queryInvariant: { html: true, rsc: false },
        }),
      ],
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 0, publishedRoutes: 0 });
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "existing-rsc-asset",
    );
    expect(fs.existsSync(path.join(clientDir, "_headers"))).toBe(false);
  });

  it("preserves query-invariance proof in the prerender manifest", () => {
    const root = createTempRoot();

    writePrerenderIndex(
      [
        renderedAppRoute("/about", ["about.html", "about.rsc"], {
          queryInvariant: { html: true, rsc: false },
        }),
      ],
      root,
    );

    const manifest = JSON.parse(fs.readFileSync(path.join(root, "vinext-prerender.json"), "utf-8"));
    expect(manifest.routes[0]).toMatchObject({
      route: "/about",
      status: "rendered",
      queryInvariant: { html: true, rsc: false },
    });
  });
});
