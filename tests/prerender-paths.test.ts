import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toSlash } from "pathslash";

const closeMock = vi.hoisted(() => vi.fn((callback: () => void) => callback()));
const startProdServerMock = vi.hoisted(() =>
  vi.fn(async () => ({ server: { close: closeMock }, port: 43210 })),
);

vi.mock("../packages/vinext/src/server/prod-server.js", () => ({
  startProdServer: startProdServerMock,
}));

let tmpDir: string;

function writeFile(relativePath: string, content: string): void {
  const fullPath = path.join(tmpDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
}

describe("prerender path manifest", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-prerender-paths-test-"));
    closeMock.mockClear();
    startProdServerMock.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const rawUrl =
          input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
        const url = new URL(rawUrl);
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/cached/:slug"
        ) {
          return Response.json([{ slug: "intro" }, { slug: "featured" }]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/cache-handler/:slug"
        ) {
          return Response.json([{ slug: "one" }, { slug: "two" }]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/:path+"
        ) {
          return Response.json([
            { path: ["pages-dir", "foobar"] },
            { path: ["pages-dir", "static"] },
            { path: ["api", "status"] },
            { path: ["specific", "value"] },
          ]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/:locale/about"
        ) {
          return Response.json([{ locale: "fr" }]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/:locale/api/status"
        ) {
          return Response.json([{ locale: "fr" }]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/:category"
        ) {
          return Response.json([{ category: "news" }]);
        }
        return new Response(null, { status: 204 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes concrete warmup paths without rendering page artifacts", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        "export const revalidate = 60;",
        "export function generateStaticParams() { return [{ slug: 'intro' }, { slug: 'featured' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile("app/cached/loading.tsx", "export default function Loading() { return null; }\n");
    writeFile(
      "app/cache-route/route.ts",
      "export const revalidate = 60; export function GET() { return new Response('cached'); }\n",
    );
    writeFile(
      "app/cache-handler/[slug]/route.ts",
      [
        "export const revalidate = 60;",
        "export function generateStaticParams() { return [{ slug: 'one' }, { slug: 'two' }]; }",
        "export function GET() { return new Response('cached'); }",
      ].join("\n"),
    );
    writeFile(
      "app/dynamic/page.tsx",
      "export const dynamic = 'force-dynamic'; export default function Page() { return null; }\n",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      buildIdentity: "response-header",
      responseVary: "verbatim",
    });

    expect(manifest).toEqual({
      buildId: "build-a",
      buildIdentity: "rsc-build-a",
      cacheabilityRoutes: [
        { kind: "app-page", path: "/", pattern: "/", probePath: "/", warmPaths: ["/"] },
        {
          kind: "app-page",
          path: "/cached/intro",
          pattern: "/cached/:slug",
          probePath: "/cached/intro",
          runtimeCheckWarmPaths: ["/cached/featured"],
          warmPaths: ["/cached/intro"],
        },
        {
          kind: "app-page",
          path: "/dynamic",
          pattern: "/dynamic",
          probePath: "/dynamic",
          warmPaths: ["/dynamic"],
        },
        {
          kind: "app-route",
          path: "/cache-handler/one",
          pattern: "/cache-handler/:slug",
          probePath: "/cache-handler/one",
          runtimeCheckWarmPaths: ["/cache-handler/two"],
          warmPaths: ["/cache-handler/one"],
        },
        {
          kind: "app-route",
          path: "/cache-route",
          pattern: "/cache-route",
          probePath: "/cache-route",
          warmPaths: ["/cache-route"],
        },
      ],
      loadingShellPaths: ["/cached/intro", "/cached/featured"],
      rscBuildId: "rsc-build-a",
      responseVary: "verbatim",
      rscPaths: ["/", "/dynamic", "/cached/intro", "/cached/featured"],
      trailingSlash: false,
      paths: ["/", "/dynamic", "/cached/intro", "/cached/featured"],
    });
    expect(fs.existsSync(path.join(tmpDir, "dist/server/prerendered-routes"))).toBe(false);
    expect(
      JSON.parse(
        fs.readFileSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"), "utf-8"),
      ),
    ).toEqual(manifest);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/__vinext/prerender/static-params?pattern=%2Fcached%2F%3Aslug",
      expect.any(Object),
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/__vinext/prerender/static-params?pattern=%2Fcache-handler%2F%3Aslug",
      expect.any(Object),
    );
    expect(startProdServerMock).toHaveBeenCalledOnce();
    expect(startProdServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rscEntryPath: toSlash(path.join(tmpDir, "dist/server/index.js")),
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("validates Cache Components Route Handler modules through the staged Worker", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("next.config.mjs", "export default { cacheComponents: true };\n");
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("dist/server/vinext-server.json", JSON.stringify({ prerenderSecret: "secret-a" }));
    writeFile("app/api/status/route.ts", "export function GET() { return new Response('ok'); }\n");
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: { baseUrl: "https://staged.example.workers.dev" },
    });

    expect(fetch).toHaveBeenCalledWith(
      "https://staged.example.workers.dev/__vinext/prerender/validate-app-routes",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-vinext-prerender-secret": "secret-a" }),
      }),
    );
  });

  it("never probes a concrete path whose middleware source can match", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/guarded/page.tsx", "export default function Page() { return null; }\n");
    writeFile("app/public/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "proxy.ts",
      [
        "export function proxy() {}",
        "export const config = {",
        "  matcher: [{ source: '/guarded', has: [{ type: 'header', key: 'authorization' }] }],",
        "};",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.cacheabilityRoutes).toEqual([
      {
        kind: "app-page",
        pattern: "/guarded",
        fallbackState: "runtime-check",
      },
      {
        kind: "app-page",
        path: "/public",
        pattern: "/public",
        probePath: "/public",
        warmPaths: ["/public"],
      },
    ]);
  });

  it("discovers dynamic paths from an uploaded Worker without loading its bundle in Node", async () => {
    // No Next.js test port applies: staged Worker version overrides and
    // cloudflare:workers bindings are Cloudflare-specific.
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", 'import { env } from "cloudflare:workers";\n');
    writeFile(
      "dist/server/vinext-server.json",
      JSON.stringify({ prerenderSecret: "staged-discovery-secret" }),
    );
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        'import { env } from "cloudflare:workers";',
        "export const revalidate = 60;",
        "export async function generateStaticParams() { await env.KV.get('paths'); return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: {
        baseUrl: "https://workers-cache.example.workers.dev/ignored-prefix",
        headers: {
          "Cloudflare-Workers-Version-Overrides": 'workers-cache="version-b"',
          "X-Vinext-Expected-Worker-Version": "version-b",
        },
      },
    });

    expect(manifest?.paths).toEqual(["/cached/intro", "/cached/featured"]);
    expect(startProdServerMock).not.toHaveBeenCalled();
    const [requestUrl, requestInit] = vi.mocked(fetch).mock.calls[0];
    const requestHeaders = new Headers(requestInit?.headers);
    expect(requestUrl).toBe(
      "https://workers-cache.example.workers.dev/__vinext/prerender/static-params?pattern=%2Fcached%2F%3Aslug",
    );
    expect(requestHeaders.get("Cloudflare-Workers-Version-Overrides")).toBe(
      'workers-cache="version-b"',
    );
    expect(requestHeaders.get("X-Vinext-Expected-Worker-Version")).toBe("version-b");
    expect(requestHeaders.get("x-vinext-prerender-secret")).toBe("staged-discovery-secret");
  });

  it("retries transient staged-version routing failures during remote discovery", async () => {
    // No Next.js test port applies: Worker version propagation is Cloudflare-specific.
    const remoteFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("old Worker", { status: 404 }))
      .mockResolvedValueOnce(Response.json([{ slug: "intro" }]));
    vi.stubGlobal("fetch", remoteFetch);
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", 'import { env } from "cloudflare:workers";\n');
    writeFile(
      "dist/server/vinext-server.json",
      JSON.stringify({ prerenderSecret: "staged-discovery-secret" }),
    );
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        "export const revalidate = 60;",
        "export async function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: {
        baseUrl: "https://workers-cache.example.workers.dev",
        retries: 1,
        retryDelayMs: 0,
      },
    });

    expect(manifest?.paths).toEqual(["/cached/intro"]);
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("does not replay user-code failures during remote discovery", async () => {
    // No Next.js test port applies: staged Worker discovery is Cloudflare-specific.
    const remoteFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ error: "binding lookup failed" }, { status: 500 }),
    );
    vi.stubGlobal("fetch", remoteFetch);
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "dist/server/vinext-server.json",
      JSON.stringify({ prerenderSecret: "staged-discovery-secret" }),
    );
    writeFile(
      "app/cached/[slug]/page.tsx",
      "export async function generateStaticParams() { return []; } export default function Page() { return null; }",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    await expect(
      emitPrerenderPathManifest({
        root: tmpDir,
        pathDiscoveryTarget: {
          baseUrl: "https://workers-cache.example.workers.dev",
          retries: 3,
          retryDelayMs: 0,
        },
      }),
    ).rejects.toThrow("path discovery returned HTTP 500");
    expect(remoteFetch).toHaveBeenCalledOnce();
  });

  it("discovers binding-backed Pages Router paths from the uploaded Worker", async () => {
    // No Next.js test port applies: staged Worker version overrides and
    // cloudflare:workers bindings are Cloudflare-specific.
    const remoteFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ fallback: false, paths: [{ params: { slug: "intro" } }] }),
    );
    vi.stubGlobal("fetch", remoteFetch);
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "pages-build-a\n");
    writeFile("dist/server/entry.js", 'import { env } from "cloudflare:workers";\n');
    writeFile(
      "dist/server/vinext-server.json",
      JSON.stringify({ prerenderSecret: "pages-discovery-secret" }),
    );
    writeFile(
      "pages/posts/[slug].tsx",
      [
        'import { env } from "cloudflare:workers";',
        "export async function getStaticPaths() { await env.KV.get('paths'); return { fallback: false, paths: [] }; }",
        "export function getStaticProps() { return { props: {} }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: {
        baseUrl: "https://pages-cache.example.workers.dev",
        headers: { "Cloudflare-Workers-Version-Overrides": 'pages-cache="version-b"' },
      },
    });

    expect(manifest?.paths).toEqual(["/posts/intro"]);
    expect(manifest?.pagesPaths).toEqual(["/posts/intro"]);
    expect(startProdServerMock).not.toHaveBeenCalled();
    const [requestUrl, requestInit] = remoteFetch.mock.calls[0];
    expect(requestUrl).toBe(
      "https://pages-cache.example.workers.dev/__vinext/prerender/pages-static-paths?pattern=%2Fposts%2F%3Aslug",
    );
    expect(new Headers(requestInit?.headers).get("x-vinext-prerender-secret")).toBe(
      "pages-discovery-secret",
    );
  });

  it("discovers strict-Vary RSC paths without consulting completed prerender output", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/page.tsx", "export const revalidate = 60; export default function Page() {}\n");
    writeFile(
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "old-build",
        routes: [
          {
            route: "/old",
            status: "rendered",
            router: "app",
            revalidate: 60,
            fallback: false,
          },
        ],
      }),
    );
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.rscPaths).toEqual(["/"]);
    expect(manifest?.rscBuildId).toBe("rsc-build-a");
  });

  it("excludes App RSC warm paths affected by configured rewrites", async () => {
    // Rewrite-aware prefetches can resolve a public URL to a different route:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/rewrite-me/page.tsx",
      "export const revalidate = 60; export default function Page() {}\n",
    );
    writeFile("app/rewrite-me/loading.tsx", "export default function Loading() { return null; }\n");
    writeFile(
      "app/safe/page.tsx",
      "export const revalidate = 60; export default function Page() {}\n",
    );
    writeFile("app/safe/loading.tsx", "export default function Loading() { return null; }\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        rewrites: () => [
          {
            source: "/rewrite-me",
            destination: "/safe",
            has: [{ type: "header", key: "x-route-variant", value: "1" }],
          },
        ],
      },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/safe"]);
    expect(manifest?.excludedWarmPaths).toEqual(["/rewrite-me"]);
    expect(manifest?.rscPaths).toEqual(["/safe"]);
    expect(manifest?.loadingShellPaths).toEqual(["/safe"]);
    expect(manifest?.cacheabilityRoutes?.find((route) => route.pattern === "/rewrite-me")).toEqual({
      fallbackState: "runtime-check",
      kind: "app-page",
      pattern: "/rewrite-me",
    });
  });

  it("probes deterministic rewrites through their public source path", async () => {
    // Next.js applies config rewrites before filesystem Route Handlers:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/concurrent-navigations/mismatching-prefetch.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/api/source/route.ts",
      'export const revalidate = 60; export function GET() { return new Response("source"); }\n',
    );
    writeFile(
      "app/api/target/route.ts",
      'export function GET() { return new Response("target"); }\n',
    );

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        rewrites: () => [{ source: "/api/source", destination: "/api/target" }],
      },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.excludedWarmPaths).toBeUndefined();
    expect(manifest?.cacheabilityRoutes).toContainEqual(
      expect.objectContaining({
        kind: "app-route",
        pattern: "/api/source",
        probePath: "/api/source",
      }),
    );
  });

  it("excludes warm paths covered by request-conditional config headers", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/conditional/page.tsx", "export default function Page() {}\n");
    writeFile("app/safe/page.tsx", "export default function Page() {}\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        headers: () => [
          {
            source: "/conditional",
            has: [{ type: "cookie", key: "private" }],
            headers: [{ key: "Cache-Control", value: "no-store" }],
          },
        ],
      },
      tmpDir,
    );
    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/safe"]);
    expect(manifest?.excludedWarmPaths).toEqual(["/conditional"]);
    expect(manifest?.cacheabilityRoutes?.find((route) => route.pattern === "/conditional")).toEqual(
      {
        fallbackState: "runtime-check",
        kind: "app-page",
        pattern: "/conditional",
      },
    );
  });

  it("excludes warm paths shadowed by configured redirects", async () => {
    // Next.js applies config redirects before rendering the filesystem route:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/navigation/navigation.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/redirect-me/page.tsx",
      "export const revalidate = 60; export default function Page() {}\n",
    );
    writeFile(
      "app/safe/page.tsx",
      "export const revalidate = 60; export default function Page() {}\n",
    );

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        redirects: () => [{ source: "/redirect-me", destination: "/safe", permanent: false }],
      },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/safe"]);
    expect(manifest?.excludedWarmPaths).toEqual(["/redirect-me"]);
    expect(manifest?.rscPaths).toEqual(["/safe"]);
  });

  it("discovers a static child route from parent-layout generateStaticParams", async () => {
    // Next.js supports parent layouts generating params for static child pages:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/app-prefetch-static/app/[region]/(default)/layout.js
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[category]/layout.tsx",
      [
        "export function generateStaticParams() { return [{ category: 'news' }]; }",
        "export default function Layout({ children }) { return children; }",
      ].join("\n"),
    );
    writeFile(
      "app/[category]/foo/page.tsx",
      "export const revalidate = 60; export default function Page() {}\n",
    );
    writeFile(
      "app/[category]/foo/loading.tsx",
      "export default function Loading() { return null; }\n",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/news/foo"]);
    expect(manifest?.rscPaths).toEqual(["/news/foo"]);
    expect(manifest?.loadingShellPaths).toEqual(["/news/foo"]);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/__vinext/prerender/static-params?pattern=%2F%3Acategory",
      expect.any(Object),
    );
  });

  it("discovers dynamic App MDX paths from the built runtime", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[slug]/page.mdx",
      'export function generateStaticParams() { return [{ slug: "hello" }] }\n\n# Hello\n',
    );
    vi.mocked(fetch).mockResolvedValue(Response.json([{ slug: "hello" }]));

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      { pageExtensions: ["tsx", "ts", "jsx", "js", "mdx"] },
      tmpDir,
    );
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      nextConfig,
      responseVary: "verbatim",
    });

    expect(manifest?.paths).toEqual(["/hello"]);
    expect(manifest?.rscPaths).toEqual(["/hello"]);
  });

  it("discovers dynamic Pages MDX paths from the built runtime", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      "pages/[slug].mdx",
      [
        'export function getStaticPaths() { return { paths: ["/hello"], fallback: false } }',
        "export function getStaticProps() { return { props: {}, revalidate: 60 } }",
        "",
        "# Hello",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json({ fallback: false, paths: ["/hello"] }));

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      { pageExtensions: ["tsx", "ts", "jsx", "js", "mdx"] },
      tmpDir,
    );
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, nextConfig });

    expect(manifest?.paths).toEqual(["/hello"]);
    expect(manifest?.pagesPaths).toEqual(["/hello"]);
  });

  it("only advertises HTML build identity when the CDN adapter guarantees it", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/page.tsx", "export default function Page() { return null; }\n");

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.buildIdentity).toBeUndefined();
    expect(manifest?.rscBuildId).toBe("rsc-build-a");
  });

  it("warms deterministic rewrites using the trailing-slash public URL", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/foo/page.tsx", "export default function Page() {}\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        trailingSlash: true,
        rewrites: () => [{ source: "/foo/", destination: "/other" }],
      },
      tmpDir,
    );
    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/foo"]);
    expect(manifest?.rscPaths).toEqual(["/foo"]);
    expect(manifest?.excludedWarmPaths).toBeUndefined();
  });

  it("warms deterministic rewrites across configured domain default locales", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/foo/page.tsx", "export default function Page() {}\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        i18n: {
          defaultLocale: "en",
          locales: ["en", "fr"],
          domains: [{ domain: "example.fr", defaultLocale: "fr" }],
        },
        rewrites: () => [{ source: "/fr/foo", destination: "/other", locale: false }],
      },
      tmpDir,
    );
    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/foo"]);
    expect(manifest?.rscPaths).toEqual(["/foo"]);
    expect(manifest?.excludedWarmPaths).toBeUndefined();
  });

  it("excludes Pages-owned hybrid paths from App warm discovery", async () => {
    // Next.js resolves matching Pages and App routes by cross-router specificity:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-params/use-params.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/pages-to-app-routing/pages-to-app-routing.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[...path]/page.tsx",
      [
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile("app/[...path]/loading.tsx", "export default function Loading() { return null; }\n");
    writeFile("app/pages-dir/static/page.tsx", "export default function Page() { return null; }\n");
    writeFile("app/specific/[id]/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "app/specific/[id]/loading.tsx",
      "export default function Loading() { return null; }\n",
    );
    writeFile("pages/pages-dir/[dynamic].tsx", "export default function Page() { return null; }\n");
    writeFile(
      "pages/api/[slug].ts",
      "export default function handler(_request, response) { response.end('ok'); }\n",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.paths).toEqual(["/pages-dir/static", "/pages-dir/foobar", "/specific/value"]);
    expect(manifest?.rscPaths).toEqual(["/pages-dir/static", "/specific/value"]);
    expect(manifest?.loadingShellPaths).toEqual(["/specific/value"]);
    expect(manifest?.pagesPaths).toEqual([]);
  });

  it("uses the runtime-best App route for App-only loading-shell discovery", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[...path]/page.tsx",
      [
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile("app/pages-dir/static/page.tsx", "export default function Page() { return null; }\n");
    writeFile("app/specific/[id]/page.tsx", "export default function Page() { return null; }\n");
    writeFile("app/api/status/route.ts", "export function GET() { return new Response('ok'); }\n");
    writeFile(
      "app/specific/[id]/loading.tsx",
      "export default function Loading() { return null; }\n",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.rscPaths).toEqual([
      "/pages-dir/static",
      "/pages-dir/foobar",
      "/specific/value",
    ]);
    expect(manifest?.paths).toEqual(["/pages-dir/static", "/pages-dir/foobar", "/specific/value"]);
    expect(manifest?.loadingShellPaths).toEqual(["/specific/value"]);
  });

  it("normalizes Pages i18n prefixes before resolving hybrid RSC ownership", async () => {
    // Next.js normalizes locale prefixes before route matching:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/base-server.ts
    // Locale-prefixed paths do not become Pages API requests after stripping:
    // https://github.com/vercel/next.js/blob/canary/test/e2e/i18n-api-support/index.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/[locale]/about/page.tsx",
      [
        "export function generateStaticParams() { return [{ locale: 'fr' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile(
      "app/[locale]/about/loading.tsx",
      "export default function Loading() { return null; }\n",
    );
    writeFile(
      "app/[locale]/api/status/page.tsx",
      [
        "export function generateStaticParams() { return [{ locale: 'fr' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile(
      "app/[locale]/api/status/loading.tsx",
      "export default function Loading() { return null; }\n",
    );
    writeFile("pages/about.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "pages/api/status.ts",
      "export default function handler(_request, response) { response.end('ok'); }\n",
    );

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      { i18n: { defaultLocale: "en", locales: ["en", "fr"] } },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/fr/api/status", "/fr/about", "/about"]);
    expect(manifest?.rscPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.loadingShellPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.pagesPaths).toEqual(["/about", "/fr/about"]);
  });

  it("resolves Pages-discovered warm paths to their runtime App owner", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/health/route.ts", "export function GET() { return new Response('ok'); }\n");
    writeFile("app/specific/[id]/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "pages/[...path].tsx",
      [
        "export function getStaticPaths() { return { paths: [], fallback: false }; }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockImplementation(async (input) => {
      const rawUrl =
        input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl);
      if (url.pathname === "/__vinext/prerender/pages-static-paths") {
        return Response.json({ fallback: false, paths: ["/health", "/specific/value"] });
      }
      return new Response(null, { status: 204 });
    });

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.paths).toEqual(["/specific/value"]);
    expect(manifest?.rscPaths).toEqual(["/specific/value"]);
    expect(manifest?.pagesPaths).toEqual(["/health", "/specific/value"]);
  });

  it("fails path discovery when generateStaticParams discovery aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }),
    );
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        "export const revalidate = 60;",
        "export function generateStaticParams() { return [{ slug: 'intro' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      "Failed to discover warmup path(s) for /cached/:slug: path discovery timed out after 30000ms",
    );
  });

  it("explains how to move cloudflare:workers path discovery out of Node", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Received protocol 'cloudflare:'",
          },
          { status: 500 },
        ),
      ),
    );
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        'import { env } from "cloudflare:workers";',
        "export const revalidate = 60;",
        "export async function generateStaticParams() { await env.KV.get('paths'); return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      "Cloudflare runtime bindings cannot execute in the local Node prerender server. Use `vinext-cloudflare deploy --experimental-warm-cdn-cache`",
    );
  });

  it("passes a custom RSC bundle path to the path discovery server", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/custom-rsc/BUILD_ID", "build-a\n");
    writeFile("dist/custom-rsc/index.js", "export default {};\n");
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        "export const revalidate = 60;",
        "export function generateStaticParams() { return [{ slug: 'intro' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const rscBundlePath = path.join(tmpDir, "dist/custom-rsc/index.js");

    await emitPrerenderPathManifest({ root: tmpDir, rscBundlePath });

    expect(startProdServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outDir: toSlash(path.join(tmpDir, "dist")),
        rscEntryPath: rscBundlePath,
      }),
    );
  });

  it("derives a custom RSC bundle path from route metadata", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/custom-rsc/BUILD_ID", "build-a\n");
    writeFile("dist/custom-rsc/index.js", "export default {};\n");
    writeFile(
      "app/cached/[slug]/page.tsx",
      [
        "export const revalidate = 60;",
        "export function generateStaticParams() { return [{ slug: 'intro' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await emitPrerenderPathManifest({
      root: tmpDir,
      routeRootConfig: { rscOutDir: "dist/custom-rsc" },
    });

    expect(startProdServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        outDir: toSlash(path.join(tmpDir, "dist")),
        rscEntryPath: toSlash(path.join(tmpDir, "dist/custom-rsc/index.js")),
      }),
    );
    expect(fs.existsSync(path.join(tmpDir, "dist/custom-rsc/vinext-prerender-paths.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(tmpDir, "dist/server/vinext-prerender-paths.json"))).toBe(true);
  });

  it("loads next.config with the production build phase", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile(
      "next.config.mjs",
      "export default (phase) => ({ trailingSlash: phase === 'phase-production-build' });\n",
    );
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/page.tsx", "export default function Page() { return null; }\n");

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({ root: tmpDir });

    expect(manifest?.trailingSlash).toBe(true);
    expect(manifest?.paths).toEqual(["/"]);
    expect(startProdServerMock).not.toHaveBeenCalled();
  });

  it("honors a configured route root when discovering paths", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/wrong/page.tsx", "export default function Page() { return null; }\n");
    writeFile("custom/app/right/page.tsx", "export default function Page() { return null; }\n");

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      routeRootConfig: { appDir: "custom" },
    });

    expect(manifest?.paths).toEqual(["/right"]);
  });

  it("honors disabled App Router when discovering paths", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/app-only/page.tsx", "export default function Page() { return null; }\n");
    writeFile("pages/pages-only.tsx", "export default function Page() { return null; }\n");

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      routeRootConfig: { disableAppRouter: true },
    });

    expect(manifest?.paths).toEqual(["/pages-only"]);
    expect(manifest?.pagesPaths).toEqual(["/pages-only"]);
  });

  it("excludes Pages API handlers from Pages-only concrete warm paths", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      "pages/[...slug].tsx",
      [
        "export function getStaticPaths() { return { paths: [], fallback: false }; }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile(
      "pages/api/[...slug].ts",
      "export default function handler(_request, response) { response.end('ok'); }\n",
    );
    vi.mocked(fetch).mockResolvedValue(
      Response.json({ fallback: false, paths: ["/page/foo", "/api/foo"] }),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir });

    expect(manifest?.paths).toEqual(["/page/foo"]);
    expect(manifest?.pagesPaths).toEqual(["/page/foo"]);
  });

  it("discovers locale-specific Pages Router warmup keys", async () => {
    // Next.js passes i18n metadata to getStaticPaths and qualifies each
    // returned pathname with its selected locale:
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/static-paths/pages.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile("pages/about.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "pages/posts/[slug].tsx",
      [
        "export function getStaticPaths() { return { paths: [], fallback: false }; }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockImplementation(async (input) => {
      const rawUrl =
        input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
      const url = new URL(rawUrl);
      if (url.pathname === "/__vinext/prerender/pages-static-paths") {
        return Response.json({
          fallback: false,
          paths: [
            { params: { slug: "hello" } },
            { params: { slug: "bonjour" }, locale: "fr" },
            "/fr/posts/string-fr",
            "/FR/posts/string-fr-upper",
            "/en/posts/string-en-explicit",
            "/posts/string-en",
            "/posts/%7Euser/",
            "/posts/a%2fb/",
          ],
        });
      }
      return new Response(null, { status: 204 });
    });

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }, { readPrerenderWarmPlan }] =
      await Promise.all([
        import("../packages/vinext/src/build/prerender-paths.js"),
        import("../packages/vinext/src/config/next-config.js"),
        import("../packages/cloudflare/src/cdn-warm.js"),
      ]);
    const nextConfig = await resolveNextConfig(
      {
        basePath: "/docs",
        i18n: { defaultLocale: "en", locales: ["en", "fr"] },
        trailingSlash: true,
      },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({ root: tmpDir, nextConfig });

    expect(manifest?.paths).toEqual([
      "/about",
      "/fr/about",
      "/posts/hello",
      "/fr/posts/bonjour",
      "/fr/posts/string-fr",
      "/FR/posts/string-fr-upper",
      "/en/posts/string-en-explicit",
      "/posts/string-en",
      "/posts/%7Euser",
      "/posts/a%2fb",
    ]);
    expect(manifest?.pagesPaths).toEqual(manifest?.paths);
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/__vinext/prerender/pages-static-paths?pattern=%2Fposts%2F%3Aslug&locales=%5B%22en%22%2C%22fr%22%5D&defaultLocale=en",
      expect.any(Object),
    );
    const warmPlan = readPrerenderWarmPlan(tmpDir);
    expect(warmPlan.paths).toEqual([
      "/docs/about/",
      "/docs/fr/about/",
      "/docs/posts/hello/",
      "/docs/fr/posts/bonjour/",
      "/docs/fr/posts/string-fr/",
      "/docs/FR/posts/string-fr-upper/",
      "/docs/en/posts/string-en-explicit/",
      "/docs/posts/string-en/",
      "/docs/posts/%7Euser/",
      "/docs/posts/a%2fb/",
    ]);
    expect(
      new Set(
        warmPlan.cacheabilityRoutes?.flatMap((route) => [
          ...(route.warmPaths ?? []),
          ...(route.runtimeCheckWarmPaths ?? []),
        ]),
      ),
    ).toEqual(new Set(warmPlan.paths));
  });

  it("fails path discovery when getStaticPaths returns an HTTP error", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      "pages/posts/[slug].tsx",
      [
        "export function getStaticPaths() { throw new Error('boom'); }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(new Response("getStaticPaths exploded", { status: 500 }));
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      "Failed to discover warmup path(s) for /posts/:slug: path discovery returned HTTP 500",
    );
  });

  it.each([
    ["null", null, "Invalid value returned"],
    ["missing paths", { fallback: false }, "Invalid paths returned"],
    ["null paths", { fallback: false, paths: null }, "Invalid paths returned"],
    ["invalid fallback", { fallback: "yes", paths: [] }, "Invalid fallback"],
    ["extra key", { extra: true, fallback: false, paths: [] }, "Extra key(s)"],
  ])("fails path discovery for %s getStaticPaths results", async (_name, result, message) => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      "pages/posts/[slug].tsx",
      [
        "export function getStaticPaths() { return null; }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json(result));
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      `Failed to discover warmup path(s) for /posts/:slug: ${message}`,
    );
  });

  it.each([
    ["an extra entry key", "/posts/[slug].tsx", { extra: true, params: { slug: "x" } }],
    ["a numeric dynamic param", "/posts/[slug].tsx", { params: { slug: 123 } }],
    ["an array dynamic param", "/posts/[slug].tsx", { params: { slug: ["a", "b"] } }],
    ["a dot-segment dynamic param", "/posts/[slug].tsx", { params: { slug: "." } }],
    ["a scalar catch-all param", "/docs/[...parts].tsx", { params: { parts: "a" } }],
    ["a query-bearing string path", "/posts/[slug].tsx", "/posts/query?x=1"],
    ["a relative string path", "/posts/[slug].tsx", "posts/x"],
    ["a double-slash string path", "/posts/[slug].tsx", "/posts//x"],
    ["a raw backslash string path", "/posts/[slug].tsx", "/posts\\admin"],
    ["an encoded dot-segment string path", "/posts/[...slug].tsx", "/posts/%2E%2E/admin"],
    ["malformed percent-encoding", "/posts/[slug].tsx", "/posts/%ZZ/"],
  ])("fails path discovery for getStaticPaths entry with %s", async (_name, file, entry) => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      `pages${file}`,
      [
        "export function getStaticPaths() { return { paths: [], fallback: false }; }",
        "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json({ fallback: false, paths: [entry] }));
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      "Failed to discover warmup path(s)",
    );
  });

  it.each([
    ["a numeric dynamic param", "app/posts/[slug]/page.tsx", [{ slug: 123 }]],
    ["a dot-segment dynamic param", "app/posts/[slug]/page.tsx", [{ slug: ".." }]],
    ["a scalar catch-all param", "app/docs/[...parts]/page.tsx", [{ parts: "a" }]],
    ["a missing optional catch-all", "app/docs/[[...parts]]/page.tsx", [{}]],
  ])("fails App path discovery for generateStaticParams with %s", async (_name, file, result) => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      file,
      [
        "export function generateStaticParams() { return []; }",
        "export const revalidate = 60;",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json(result));
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(emitPrerenderPathManifest({ root: tmpDir })).rejects.toThrow(
      "Failed to discover warmup path(s)",
    );
  });

  it("warms locale-specific deterministic Pages rewrites", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile("pages/about.tsx", "export default function Page() { return null; }\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig(
      {
        i18n: { defaultLocale: "en", locales: ["en", "fr"] },
        rewrites: () => [{ source: "/fr/about", destination: "/other", locale: false }],
      },
      tmpDir,
    );

    const manifest = await emitPrerenderPathManifest({
      nextConfig,
      responseVary: "verbatim",
      root: tmpDir,
    });

    expect(manifest?.paths).toEqual(["/about", "/fr/about"]);
    expect(manifest?.pagesPaths).toEqual(["/about", "/fr/about"]);
    expect(manifest?.excludedWarmPaths).toBeUndefined();
  });

  it("does not reload disk config when supplied resolved config", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("next.config.mjs", 'throw new Error("disk config loaded unexpectedly");\n');
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/page.tsx", "export default function Page() { return null; }\n");

    const [{ emitPrerenderPathManifest }, { resolveNextConfig }] = await Promise.all([
      import("../packages/vinext/src/build/prerender-paths.js"),
      import("../packages/vinext/src/config/next-config.js"),
    ]);
    const nextConfig = await resolveNextConfig({ trailingSlash: true }, tmpDir);

    const manifest = await emitPrerenderPathManifest({ root: tmpDir, nextConfig });

    expect(manifest?.trailingSlash).toBe(true);
    expect(manifest?.paths).toEqual(["/"]);
  });
});
