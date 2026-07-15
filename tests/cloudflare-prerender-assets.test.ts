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
  isCloudflareRscTransportAllowedForAssetsConfig,
  readRootWranglerAssetsConfig,
} from "../packages/vinext/src/build/cloudflare-static-assets-config.js";
import type { PrerenderRouteResult } from "../packages/vinext/src/build/prerender.js";
import { STATIC_CACHE_CONTROL } from "../packages/vinext/src/server/cache-control.js";
import { VINEXT_RSC_CONTENT_TYPE } from "../packages/vinext/src/server/app-rsc-cache-busting.js";
import {
  createRscTransportAssetPathname,
  VINEXT_STATIC_RSC_TRANSPORT_PREFIX,
} from "../packages/vinext/src/server/app-rsc-transport.js";
import { withEnvVar } from "./env-test-helpers.js";

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

function applyHeadersRules(content: string, pathname: string): Headers {
  const headers = new Headers();
  let activePattern: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;

    if (!/^\s/.test(line)) {
      activePattern = line.trim();
      continue;
    }
    if (activePattern === null || !matchesHeaderRule(activePattern, pathname)) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith("! ")) {
      headers.delete(trimmed.slice(2));
      continue;
    }

    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;
    headers.append(trimmed.slice(0, separator), trimmed.slice(separator + 1).trim());
  }

  return headers;
}

function matchesHeaderRule(pattern: string, pathname: string): boolean {
  if (!pattern.includes("*")) return pattern === pathname;
  const [prefix, suffix] = pattern.split("*", 2);
  return pathname.startsWith(prefix) && pathname.endsWith(suffix ?? "");
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

    const result = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
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

    expect(result).toEqual({ skipped: false, publishedFiles: 4, publishedRoutes: 2 });
    expect(fs.readFileSync(path.join(clientDir, "index.html"), "utf-8")).toBe("<h1>Home</h1>");
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("<h1>About</h1>");
    expect(fs.existsSync(path.join(clientDir, "about.rsc"))).toBe(false);
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
    expect(headers).toContain("/\n  ! Content-Type\n  ! Cache-Control");
    expect(headers).toContain("/about\n  ! Content-Type\n  ! Cache-Control");
    expect(headers).toContain("  Content-Type: text/html; charset=utf-8");
    expect(headers).toContain("  X-Vinext-Cache: STATIC");
    expect(headers).toContain("  x-nextjs-cache: HIT");
    expect(headers).toContain("  Link: </_next/static/about.css>; rel=preload");
    expect(headers).toContain(
      `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/*\n  ! Content-Type\n  ! Cache-Control`,
    );
    expect(headers).not.toContain(`${staticRscAssetPath("/about")}\n`);
    expect(
      headers
        .split(/\r?\n/)
        .filter((line) => line.trim() === `${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/*`),
    ).toHaveLength(1);
    expect(headers).toContain("  X-Vinext-RSC-Compatibility-Id: rsc-compat-test");
    expect(headers).toContain("  x-nextjs-deployment-id: deploy-test");

    const regularStaticHeaders = applyHeadersRules(headers, "/_next/static/app.js");
    expect(regularStaticHeaders.get("Cache-Control")).toBe("public, max-age=31536000, immutable");

    const rscHeaders = applyHeadersRules(headers, staticRscAssetPath("/about"));
    expect(rscHeaders.get("Cache-Control")).toBe(STATIC_CACHE_CONTROL);
    expect(rscHeaders.get("Content-Type")).toBe(VINEXT_RSC_CONTENT_TYPE);
    expect(rscHeaders.get("Cache-Control")).not.toContain("immutable");
  });

  it("publishes only transport RSC when the app has server actions", async () => {
    // Server actions POST to the visible page path; a published HTML asset at
    // that path makes Cloudflare's asset worker answer 405 instead of invoking
    // the Worker. The GET-only reserved RSC transport path stays published.
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const publish = async (hasServerActions: boolean) =>
      publishCloudflarePrerenderedAppAssets({
        hasServerActions,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
        serverDir,
      });

    const result = await publish(true);
    expect(result).toEqual({ skipped: false, publishedFiles: 1, publishedRoutes: 1 });
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "about-rsc",
    );
    const headers = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(headers).not.toContain("/about\n");
    expect(headers).toContain(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/*`);

    // A repeat prerender of a build that gained server actions must prune the
    // previously-owned visible HTML, not leave a stale POST-shadowing asset.
    await publish(false);
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("<h1>About</h1>");
    await publish(true);
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "about-rsc",
    );
  });

  it("publishes descendants and skips ancestor HTML when visible paths conflict", async () => {
    // `/blog` needs dist/client/blog as a file while `/blog/post` needs it as
    // a directory; they cannot coexist. The ancestor keeps Worker rendering
    // (HTML skipped, RSC still published) and the descendant publishes fully.
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "blog.html"), "<h1>Blog</h1>");
    writeFile(path.join(prerenderDir, "blog.rsc"), "blog-rsc");
    writeFile(path.join(prerenderDir, "blog/post.html"), "<h1>Post</h1>");
    writeFile(path.join(prerenderDir, "blog/post.rsc"), "post-rsc");

    const publish = async (
      routes: Parameters<typeof publishCloudflarePrerenderedAppAssets>[0]["routes"],
    ) =>
      publishCloudflarePrerenderedAppAssets({
        hasServerActions: false,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes,
        serverDir,
      });

    const result = await publish([
      renderedAppRoute("/blog", ["blog.html", "blog.rsc"]),
      renderedAppRoute("/blog/post", ["blog/post.html", "blog/post.rsc"]),
    ]);

    expect(result).toEqual({ skipped: false, publishedFiles: 3, publishedRoutes: 2 });
    expect(fs.statSync(path.join(clientDir, "blog")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(clientDir, "blog/post"), "utf-8")).toBe("<h1>Post</h1>");
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/blog")}`), "utf-8")).toBe(
      "blog-rsc",
    );
    expect(
      fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/blog/post")}`), "utf-8"),
    ).toBe("post-rsc");
    const headers = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(headers).toContain("/blog/post\n");
    expect(headers).not.toContain("/blog\n");

    // Once the descendant disappears, a repeat prerender prunes its file and
    // the now-empty directory so the ancestor's HTML can publish as a file.
    const ancestorOnly = await publish([renderedAppRoute("/blog", ["blog.html", "blog.rsc"])]);
    expect(ancestorOnly).toEqual({ skipped: false, publishedFiles: 2, publishedRoutes: 1 });
    expect(fs.readFileSync(path.join(clientDir, "blog"), "utf-8")).toBe("<h1>Blog</h1>");
    expect(fs.existsSync(path.join(clientDir, "blog/post"))).toBe(false);
  });

  it("degrades to Worker rendering when a foreign parent file blocks a descendant target", async () => {
    // A pre-existing user asset file at dist/client/blog blocks the parent
    // directory /blog/post needs. The exact-target foreign check cannot see
    // it, so publishAsset must degrade to "not published" (mkdir and even the
    // temp-file cleanup throw ENOTDIR here) instead of aborting the prerender.
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(clientDir, "blog"), "user asset");
    writeFile(path.join(prerenderDir, "blog/post.html"), "<h1>Post</h1>");
    writeFile(path.join(prerenderDir, "blog/post.rsc"), "post-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [renderedAppRoute("/blog/post", ["blog/post.html", "blog/post.rsc"])],
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 1, publishedRoutes: 1 });
    expect(fs.readFileSync(path.join(clientDir, "blog"), "utf-8")).toBe("user asset");
    expect(
      fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/blog/post")}`), "utf-8"),
    ).toBe("post-rsc");
    const headers = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(headers).not.toContain("/blog/post\n");
  });

  it("skips publication when generated _headers rules would exceed the Cloudflare limit", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);

    // 100 user-authored rules already consume the entire Cloudflare budget, so
    // even a single generated HTML rule pushes the file over the limit.
    const userRules = Array.from({ length: 100 }, (_, index) => `/u${index}\n  X-Test: 1`).join(
      "\n",
    );
    writeFile(path.join(clientDir, "_headers"), `${userRules}\n`);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
      serverDir,
    });

    expect(result.skipped).toBe(true);
    expect(result.skipped && result.reason).toContain("100-rule");
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(false);
    // The user's `_headers` file is left untouched when publication is skipped.
    expect(fs.readFileSync(path.join(clientDir, "_headers"), "utf-8")).toBe(`${userRules}\n`);
  });

  it("does not publish when middleware or config request transforms are present", async () => {
    const middlewareRoot = createTempRoot();
    const middlewareServerDir = path.join(middlewareRoot, "dist/server");
    const middlewarePrerenderDir = path.join(middlewareServerDir, "prerendered-routes");
    writeWrangler(middlewareServerDir);
    writeFile(path.join(middlewareRoot, "middleware.ts"), "export function middleware() {}\n");
    writeFile(path.join(middlewarePrerenderDir, "about.html"), "<h1>About</h1>");

    const middlewareResult = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
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
      hasServerActions: false,
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
      hasServerActions: false,
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

  it("publishes HTML without static RSC when only the HTML query-invariance proof is present", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
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
      hasServerActions: false,
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

  it("re-publishes its own assets idempotently on a repeated run", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const publish = async () =>
      publishCloudflarePrerenderedAppAssets({
        hasServerActions: false,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
        rscCompatibilityId: "rsc-compat-test",
        serverDir,
      });

    const first = await publish();
    expect(first).toEqual({ skipped: false, publishedFiles: 2, publishedRoutes: 1 });
    const firstHeaders = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");

    // A second run against the same output re-publishes the assets it owns and
    // keeps the generated block and its headers rather than dropping them (the
    // owned assets stay on disk and must not be served without headers).
    const second = await publish();
    expect(second).toEqual({ skipped: false, publishedFiles: 2, publishedRoutes: 1 });
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("<h1>About</h1>");
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "about-rsc",
    );

    const secondHeaders = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(secondHeaders).toBe(firstHeaders);
    const htmlHeaders = applyHeadersRules(secondHeaders, "/about");
    expect(htmlHeaders.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(htmlHeaders.get("Cache-Control")).toBe(STATIC_CACHE_CONTROL);
    const rscHeaders = applyHeadersRules(secondHeaders, staticRscAssetPath("/about"));
    expect(rscHeaders.get("Content-Type")).toBe(VINEXT_RSC_CONTENT_TYPE);
    expect(rscHeaders.get("Cache-Control")).toBe(STATIC_CACHE_CONTROL);
  });

  it("overwrites owned assets when the prerender output changes", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "about-v1");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc-v1");

    const publish = async () =>
      publishCloudflarePrerenderedAppAssets({
        hasServerActions: false,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
        serverDir,
      });

    await publish();
    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("about-v1");

    // The same route re-renders to different output; the owned client assets
    // must be replaced, not left stale.
    writeFile(path.join(prerenderDir, "about.html"), "about-v2");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc-v2");
    await publish();

    expect(fs.readFileSync(path.join(clientDir, "about"), "utf-8")).toBe("about-v2");
    expect(fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`), "utf-8")).toBe(
      "about-rsc-v2",
    );
  });

  it("removes owned assets that are no longer desired", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(prerenderDir, "about.html"), "about-html");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");
    writeFile(path.join(prerenderDir, "contact.html"), "contact-html");
    writeFile(path.join(prerenderDir, "contact.rsc"), "contact-rsc");

    const publish = async (routes: PrerenderRouteResult[]) =>
      publishCloudflarePrerenderedAppAssets({
        hasServerActions: false,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes,
        serverDir,
      });

    await publish([
      renderedAppRoute("/about", ["about.html", "about.rsc"]),
      renderedAppRoute("/contact", ["contact.html", "contact.rsc"]),
    ]);
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(true);

    await publish([renderedAppRoute("/contact", ["contact.html", "contact.rsc"])]);

    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, "contact"), "utf-8")).toBe("contact-html");
    expect(
      fs.readFileSync(path.join(clientDir, `.${staticRscAssetPath("/contact")}`), "utf-8"),
    ).toBe("contact-rsc");

    const headers = fs.readFileSync(path.join(clientDir, "_headers"), "utf-8");
    expect(headers).not.toContain("/about\n");
    expect(headers).toContain("/contact\n");
    expect(headers).toContain(`${VINEXT_STATIC_RSC_TRANSPORT_PREFIX}/*`);
  });

  it("unpublishes owned assets when a global safety gate skips publication", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);
    writeFile(path.join(clientDir, "_headers"), "/user\n  X-User: 1\n");
    writeFile(path.join(prerenderDir, "about.html"), "about-html");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const first = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
      serverDir,
    });
    expect(first).toEqual({ skipped: false, publishedFiles: 2, publishedRoutes: 1 });
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(true);

    writeFile(path.join(root, "middleware.ts"), "export function middleware() {}\n");
    const second = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
      serverDir,
    });

    expect(second).toEqual({
      skipped: true,
      reason: "middleware/proxy must run before page responses",
      publishedFiles: 0,
      publishedRoutes: 0,
    });
    expect(fs.existsSync(path.join(clientDir, "about"))).toBe(false);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(false);
    expect(fs.readFileSync(path.join(clientDir, "_headers"), "utf-8")).toBe("/user\n  X-User: 1\n");
  });

  it("uses the selected Wrangler environment when gating static transport publication", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    writeWrangler(serverDir);
    writeFile(
      path.join(root, "wrangler.jsonc"),
      JSON.stringify({
        assets: {
          binding: "ASSETS",
          directory: "dist/client",
          not_found_handling: "none",
        },
        env: {
          preview: {
            assets: {
              not_found_handling: "single-page-application",
            },
          },
        },
      }),
    );
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    await withEnvVar("CLOUDFLARE_ENV", "preview", async () => {
      const result = publishCloudflarePrerenderedAppAssets({
        hasServerActions: false,
        config: await baseConfig(),
        prerenderDir,
        root,
        routes: [renderedAppRoute("/about", ["about.html", "about.rsc"])],
        serverDir,
      });

      expect(result).toEqual({
        skipped: true,
        reason: "Cloudflare RSC transport is disabled for the selected Wrangler environment",
        publishedFiles: 0,
        publishedRoutes: 0,
      });
    });
  });

  it("resolves env-specific Wrangler asset overrides for static transport gating", () => {
    const root = createTempRoot();
    writeFile(
      path.join(root, "wrangler.jsonc"),
      `{
        // top-level production fallback is disabled for static RSC transport
        "assets": {
          "binding": "ASSETS",
          "directory": "dist/client",
          "not_found_handling": "single-page-application",
        },
        "env": {
          "production": {
            "assets": {
              "not_found_handling": "none",
            },
          }
        },
      }`,
    );

    const topLevel = readRootWranglerAssetsConfig(root, undefined);
    const production = readRootWranglerAssetsConfig(root, "production");

    expect(topLevel.ok && isCloudflareRscTransportAllowedForAssetsConfig(topLevel.assets)).toBe(
      false,
    );
    expect(production.ok && isCloudflareRscTransportAllowedForAssetsConfig(production.assets)).toBe(
      true,
    );
  });

  it("skips static assets whose filenames exceed the filesystem cap instead of crashing", async () => {
    const root = createTempRoot();
    const serverDir = path.join(root, "dist/server");
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    const clientDir = path.join(root, "dist/client");
    writeWrangler(serverDir);

    // 200-byte final segment: the visible HTML asset name fits the 255-byte
    // filename cap, but its base64url RSC token (268 bytes + ".rsc") does not.
    const longName = "a".repeat(200);
    writeFile(path.join(prerenderDir, `${longName}.html`), "<h1>Long</h1>");
    writeFile(path.join(prerenderDir, `${longName}.rsc`), "long-rsc");
    writeFile(path.join(prerenderDir, "about.html"), "<h1>About</h1>");
    writeFile(path.join(prerenderDir, "about.rsc"), "about-rsc");

    const result = publishCloudflarePrerenderedAppAssets({
      hasServerActions: false,
      config: await baseConfig(),
      prerenderDir,
      root,
      routes: [
        renderedAppRoute(`/${longName}`, [`${longName}.html`, `${longName}.rsc`]),
        renderedAppRoute("/about", ["about.html", "about.rsc"]),
      ],
      serverDir,
    });

    expect(result).toEqual({ skipped: false, publishedFiles: 3, publishedRoutes: 2 });
    expect(fs.existsSync(path.join(clientDir, longName))).toBe(true);
    expect(fs.existsSync(path.join(clientDir, `.${staticRscAssetPath("/about")}`))).toBe(true);
    const rscDir = path.join(clientDir, "_next/static/__vinext/prerendered-rsc");
    expect(fs.readdirSync(rscDir)).toHaveLength(1);
  });

  it("treats unparsable Wrangler config formats as unreadable for transport gating", () => {
    const root = createTempRoot();
    writeFile(
      path.join(root, "wrangler.toml"),
      `[assets]\ndirectory = "dist/client"\nnot_found_handling = "single-page-application"\n`,
    );

    expect(readRootWranglerAssetsConfig(root, undefined)).toEqual({ ok: false });
  });
});
