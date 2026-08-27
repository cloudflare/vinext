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
          url.searchParams.get("pattern") === "/policy/:slug"
        ) {
          return Response.json([{ slug: "ordinary" }, { slug: "special" }]);
        }
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/unlisted/:slug"
        ) {
          return Response.json([{ slug: "known" }]);
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
        if (
          url.pathname === "/__vinext/prerender/static-params" &&
          url.searchParams.get("pattern") === "/api/items/:slug"
        ) {
          return Response.json([{ slug: "one" }, { slug: "two" }]);
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
      appPaths: ["/", "/dynamic", "/cached/intro", "/cached/featured"],
      buildId: "build-a",
      buildIdentity: "rsc-build-a",
      loadingShellPaths: ["/cached/intro", "/cached/featured"],
      rscBuildId: "rsc-build-a",
      responseVary: "verbatim",
      routePatterns: {
        "/": {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page",
          pattern: "/",
        },
        "/cached/featured": {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page",
          pattern: "/cached/:slug",
        },
        "/cached/intro": {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page",
          pattern: "/cached/:slug",
        },
        "/dynamic": {
          cacheabilityProbe: { canPrunePattern: true },
          kind: "app-page",
          pattern: "/dynamic",
        },
      },
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
    expect(startProdServerMock).toHaveBeenCalledOnce();
    expect(startProdServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rscEntryPath: toSlash(path.join(tmpDir, "dist/server/index.js")),
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
  });

  it("marks probe collapses unsafe when config cache policy varies by path or request", async () => {
    // Next.js applies pathname-specific custom Cache-Control to dynamic App
    // routes and evaluates has/missing conditions against each request:
    // test/e2e/app-dir/custom-cache-control/custom-cache-control.test.ts
    // test/e2e/custom-routes/custom-routes.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/policy/[slug]/page.tsx",
      [
        "export const dynamic = 'force-dynamic';",
        "export function generateStaticParams() { return [{ slug: 'ordinary' }, { slug: 'special' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile(
      "app/conditional/page.tsx",
      "export const dynamic = 'force-dynamic'; export default function Page() { return null; }\n",
    );
    writeFile("app/cookie/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "app/unlisted/[slug]/page.tsx",
      [
        "export const dynamic = 'force-dynamic';",
        "export function generateStaticParams() { return [{ slug: 'known' }]; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile("app/wildcard/path/page.tsx", "export default function Page() { return null; }\n");
    writeFile(
      "next.config.mjs",
      [
        "export default {",
        "  headers: async () => [",
        "    { source: '/policy/special', headers: [{ key: 'Cache-Control', value: 's-maxage=60' }] },",
        "    { source: '/conditional', missing: [{ type: 'query', key: '_rsc' }], headers: [{ key: 'Cache-Control', value: 's-maxage=60' }] },",
        "    { source: '/cookie', has: [{ type: 'query', key: '_rsc', value: '.*' }], headers: [{ key: 'Set-Cookie', value: 'rsc=1' }] },",
        "    { source: '/unlisted/public-only', headers: [{ key: 'Cache-Control', value: 's-maxage=60' }] },",
        "    { source: '/wildcard/*', missing: [{ type: 'query', key: '_rsc', value: '.*' }], headers: [{ key: 'Cache-Control', value: 's-maxage=60' }] },",
        "  ],",
        "};",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      buildIdentity: "response-header",
      responseVary: "verbatim",
    });

    expect(manifest?.routePatterns).toMatchObject({
      "/conditional": {
        cacheabilityProbe: { canPrunePattern: false },
      },
      "/cookie": {
        cacheabilityProbe: { canPrunePattern: true },
      },
      "/policy/ordinary": {
        cacheabilityProbe: { canPrunePattern: false },
      },
      "/policy/special": {
        cacheabilityProbe: { canPrunePattern: false },
      },
      "/unlisted/known": {
        cacheabilityProbe: { canPrunePattern: false },
      },
      "/wildcard/path": {
        cacheabilityProbe: { canPrunePattern: false },
      },
    });
  });

  it("discovers only Next.js-static Route Handler GET identities", async () => {
    // Ported from Next.js static eligibility and dynamic Route Handler params:
    // packages/next/src/server/route-modules/app-route/helpers/is-static-gen-enabled.ts
    // test/e2e/app-dir/app-static/app-static.test.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/api/static/route.ts",
      "export const revalidate = 60; export function GET() { return Response.json({ ok: true }); }",
    );
    writeFile(
      "app/api/dynamic/route.ts",
      "export function GET(request) { return Response.json({ url: request.url }); }",
    );
    writeFile(
      "app/api/items/[slug]/route.ts",
      [
        "export const revalidate = false;",
        "export function generateStaticParams() { return [{ slug: 'one' }, { slug: 'two' }]; }",
        "export function GET(_request, { params }) { return Response.json(params); }",
      ].join("\n"),
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      buildIdentity: "response-header",
      responseVary: "verbatim",
    });

    expect(manifest?.routeHandlerPaths).toEqual([
      "/api/static",
      "/api/items/one",
      "/api/items/two",
    ]);
    expect(manifest?.paths).toEqual([]);
    expect(manifest?.rscPaths).toEqual([]);
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
      .mockResolvedValueOnce(new Response("version still propagating", { status: 500 }))
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
        retries: 2,
        retryDelayMs: 0,
      },
    });

    expect(manifest?.paths).toEqual(["/cached/intro"]);
    expect(remoteFetch).toHaveBeenCalledTimes(3);
  });

  it("uses the full discovery phase when no retry limit is configured", async () => {
    // No Next.js test port applies: Worker version propagation is Cloudflare-specific.
    let attempts = 0;
    const remoteFetch = vi.fn<typeof fetch>(async () => {
      attempts++;
      return attempts <= 61
        ? new Response("old Worker", { status: 404 })
        : Response.json([{ slug: "intro" }]);
    });
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
      "export async function generateStaticParams() { return []; } export default function Page() { return null; }",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: {
        baseUrl: "https://workers-cache.example.workers.dev",
        phaseTimeoutMs: 120_000,
        retryDelayMs: 0,
      },
    });

    expect(manifest?.paths).toEqual(["/cached/intro"]);
    expect(remoteFetch).toHaveBeenCalledTimes(62);
  });

  it("reports exhausted discovery attempts and the last transient status", async () => {
    // No Next.js test port applies: Worker version propagation is Cloudflare-specific.
    const remoteFetch = vi.fn<typeof fetch>(
      async () => new Response("old Worker", { status: 503 }),
    );
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
      "export async function generateStaticParams() { return []; } export default function Page() { return null; }",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    await expect(
      emitPrerenderPathManifest({
        root: tmpDir,
        pathDiscoveryTarget: {
          baseUrl: "https://workers-cache.example.workers.dev",
          retries: 1,
          retryDelayMs: 0,
        },
      }),
    ).rejects.toThrow(
      "path discovery returned HTTP 503 after 2 attempt(s); last transient status was HTTP 503",
    );
    expect(remoteFetch).toHaveBeenCalledTimes(2);
  });

  it("bounds all remote discovery retries by one phase deadline", async () => {
    // No Next.js test port applies: staged Worker discovery is Cloudflare-specific.
    const remoteFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("old Worker", { status: 503 }))
      .mockResolvedValueOnce(new Response("old Worker", { status: 503 }))
      // The phase deadline remains authoritative even if fetch ignores abort.
      .mockImplementation(() => new Promise<Response>(() => {}));
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
      "export async function generateStaticParams() { return []; } export default function Page() { return null; }",
    );

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const discovery = emitPrerenderPathManifest({
      root: tmpDir,
      pathDiscoveryTarget: {
        baseUrl: "https://workers-cache.example.workers.dev",
        phaseTimeoutMs: 100,
        retries: 60,
        retryDelayMs: 10,
      },
    });
    await expect(discovery).rejects.toThrow(
      "remote path discovery exceeded its 100ms phase deadline",
    );
    expect(remoteFetch).toHaveBeenCalledTimes(3);
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
    ).rejects.toThrow("path discovery returned HTTP 500: binding lookup failed");
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

  it("matches rewrites against the trailing-slash warm URL", async () => {
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

    expect(manifest?.paths).toEqual([]);
    expect(manifest?.rscPaths).toEqual([]);
    expect(manifest?.excludedWarmPaths).toEqual(["/foo"]);
  });

  it("checks rewrite identity for every configured domain default locale", async () => {
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

    expect(manifest?.paths).toEqual([]);
    expect(manifest?.rscPaths).toEqual([]);
    expect(manifest?.excludedWarmPaths).toEqual(["/foo"]);
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
    expect(manifest?.appPaths).toEqual(["/pages-dir/static", "/specific/value"]);
    expect(manifest?.rscPaths).toEqual(["/pages-dir/static", "/specific/value"]);
    expect(manifest?.loadingShellPaths).toEqual(["/specific/value"]);
    expect(manifest?.pagesPaths).toEqual(["/pages-dir/foobar"]);
  });

  it("retains empty generateStaticParams patterns for on-demand admission", async () => {
    // Ported from Next.js: test/e2e/app-dir/fallback-prefetch
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/fallback-prefetch
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/posts/[slug]/page.tsx",
      [
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json([]));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({
      root: tmpDir,
      responseVary: "verbatim",
    });

    expect(manifest?.paths).toEqual([]);
    expect(manifest?.fallbackRoutePatterns).toEqual([
      { kind: "app-page", pattern: "/posts/:slug" },
    ]);
  });

  it("rejects empty generateStaticParams for a Cache Components App Page", async () => {
    // Ported from Next.js: test/e2e/app-dir/empty-generate-static-params
    // https://github.com/vercel/next.js/tree/canary/test/e2e/app-dir/empty-generate-static-params
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("next.config.js", "export default { cacheComponents: true };\n");
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/posts/[slug]/page.tsx",
      [
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json([]));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    await expect(
      emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" }),
    ).rejects.toThrow(
      "When using Cache Components, all `generateStaticParams` functions must return at least one result.",
    );
  });

  it.each([
    [
      "empty generateStaticParams",
      [
        "export function generateStaticParams() { return []; }",
        "export function GET() { return Response.json({ ok: true }); }",
      ].join("\n"),
      Response.json([]),
    ],
    [
      "empty generateStaticParams with Cache Components",
      [
        "export function generateStaticParams() { return []; }",
        "export function GET() { return Response.json({ ok: true }); }",
      ].join("\n"),
      Response.json([]),
      true,
    ],
    [
      "force-static without generateStaticParams",
      [
        'export const dynamic = "force-static";',
        "export function GET() { return Response.json({ ok: true }); }",
      ].join("\n"),
      new Response(null, { status: 204 }),
      false,
    ],
  ])(
    "retains dynamic App Route Handler patterns with %s",
    async (_name, source, response, cacheComponents = false) => {
      // Ported from Next.js static App Route eligibility:
      // packages/next/src/server/route-modules/app-route/helpers/is-static-gen-enabled.ts
      writeFile("package.json", JSON.stringify({ type: "module" }));
      if (cacheComponents) {
        writeFile("next.config.js", "export default { cacheComponents: true };\n");
      }
      writeFile("dist/server/BUILD_ID", "build-a\n");
      writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
      writeFile("dist/server/index.js", "export default {};\n");
      writeFile("app/api/layout.tsx", 'export const dynamic = "force-dynamic";\n');
      writeFile("app/api/posts/[slug]/route.ts", source);
      vi.mocked(fetch).mockResolvedValue(response);

      const { emitPrerenderPathManifest } =
        await import("../packages/vinext/src/build/prerender-paths.js");
      const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

      expect(manifest?.routeHandlerPaths).toBeUndefined();
      expect(manifest?.fallbackRoutePatterns).toEqual([
        { kind: "app-route", pattern: "/api/posts/:slug" },
      ]);
    },
  );

  it.each([
    [true, true],
    ["blocking", true],
    [false, false],
  ] as const)(
    "retains zero-path Pages fallback=%s eligibility as a pattern record",
    async (fallback, shouldRetain) => {
      // Ported from Next.js:
      // test/e2e/prerender/pages/non-json/[p].js
      // test/e2e/prerender/pages/non-json-blocking/[p].js
      writeFile("package.json", JSON.stringify({ type: "module" }));
      writeFile("dist/server/BUILD_ID", "build-a\n");
      writeFile("dist/server/entry.js", "export default {};\n");
      writeFile(
        "pages/posts/[slug].tsx",
        [
          "export function getStaticPaths() { return { paths: [], fallback: false }; }",
          "export function getStaticProps() { return { props: {}, revalidate: 60 }; }",
          "export default function Page() { return null; }",
        ].join("\n"),
      );
      vi.mocked(fetch).mockResolvedValue(Response.json({ fallback, paths: [] }));

      const { emitPrerenderPathManifest } =
        await import("../packages/vinext/src/build/prerender-paths.js");
      const manifest = await emitPrerenderPathManifest({ root: tmpDir });

      expect(manifest?.paths).toEqual([]);
      expect(manifest?.fallbackRoutePatterns).toEqual(
        shouldRetain ? [{ kind: "pages-page", pattern: "/posts/:slug" }] : undefined,
      );
    },
  );

  it("retains force-static patterns without generateStaticParams", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/posts/[slug]/page.tsx",
      [
        'export const dynamic = "force-static";',
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.fallbackRoutePatterns).toEqual([
      { kind: "app-page", pattern: "/posts/:slug" },
    ]);
  });

  it("does not certify an empty static params pattern beneath force-dynamic config", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/posts/layout.tsx", 'export const dynamic = "force-dynamic";\n');
    writeFile(
      "app/posts/[slug]/page.tsx",
      [
        'export const dynamic = "force-static";',
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json([]));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.fallbackRoutePatterns).toBeUndefined();
  });

  it("does not certify empty static params with a force-dynamic parallel default", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/posts/[slug]/page.tsx",
      [
        'export const dynamic = "force-static";',
        "export function generateStaticParams() { return []; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    writeFile(
      "app/posts/@sidebar/default.tsx",
      [
        'export const dynamic = "force-dynamic";',
        "export default function Sidebar() { return null; }",
      ].join("\n"),
    );
    vi.mocked(fetch).mockResolvedValue(Response.json([]));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.fallbackRoutePatterns).toBeUndefined();
  });

  it("does not treat revalidate without generateStaticParams as a static fallback", async () => {
    // Next.js only treats a dynamic route without generateStaticParams as static
    // when its effective dynamic config is `error` or `force-static`.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile(
      "app/posts/[slug]/page.tsx",
      ["export const revalidate = 60;", "export default function Page() { return null; }"].join(
        "\n",
      ),
    );
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.fallbackRoutePatterns).toBeUndefined();
  });

  it("does not inherit force-static past an explicit child auto without generateStaticParams", async () => {
    // Next.js uses the nested-most dynamic config on the main segment chain.
    // https://github.com/vercel/next.js/blob/canary/packages/next/src/build/utils.ts#L1028
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/RSC_BUILD_ID", "rsc-build-a\n");
    writeFile("dist/server/index.js", "export default {};\n");
    writeFile("app/posts/layout.tsx", 'export const dynamic = "force-static";\n');
    writeFile(
      "app/posts/[slug]/page.tsx",
      ['export const dynamic = "auto";', "export default function Page() { return null; }"].join(
        "\n",
      ),
    );
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");
    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest?.fallbackRoutePatterns).toBeUndefined();
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
    expect(manifest?.appPaths).toEqual([
      "/pages-dir/static",
      "/pages-dir/foobar",
      "/specific/value",
    ]);
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
    expect(manifest?.appPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.rscPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.loadingShellPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.pagesPaths).toEqual(["/fr/about", "/about"]);
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
    expect(manifest?.appPaths).toEqual(["/specific/value"]);
    expect(manifest?.rscPaths).toEqual(["/specific/value"]);
    expect(manifest?.pagesPaths).toEqual([]);
    expect(manifest?.pagesDataPaths).toEqual([]);
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
    expect(manifest?.routePatterns).toEqual({
      "/pages-only": {
        cacheabilityProbe: { canPrunePattern: true },
        kind: "pages-page",
        pattern: "/pages-only",
      },
    });
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
    expect(manifest?.pagesDataPaths).toEqual([
      "/docs/_next/data/build-a/en/posts/hello.json",
      "/docs/_next/data/build-a/fr/posts/bonjour.json",
      "/docs/_next/data/build-a/fr/posts/string-fr.json",
      "/docs/_next/data/build-a/FR/posts/string-fr-upper.json",
      "/docs/_next/data/build-a/en/posts/string-en-explicit.json",
      "/docs/_next/data/build-a/en/posts/string-en.json",
      "/docs/_next/data/build-a/en/posts/%7Euser.json",
      "/docs/_next/data/build-a/en/posts/a%2fb.json",
    ]);
    expect(
      manifest?.routePatterns?.["/docs/_next/data/build-a/en/posts/hello.json"]?.cacheabilityProbe
        ?.concretePathname,
    ).toBe("/docs/posts/hello");
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:43210/__vinext/prerender/pages-static-paths?pattern=%2Fposts%2F%3Aslug&locales=%5B%22en%22%2C%22fr%22%5D&defaultLocale=en",
      expect.any(Object),
    );
    expect(readPrerenderWarmPlan(tmpDir).paths).toEqual([
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

  it("excludes only the locale-specific Pages key affected by a rewrite", async () => {
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

    expect(manifest?.paths).toEqual(["/about"]);
    expect(manifest?.pagesPaths).toEqual(["/about"]);
    expect(manifest?.excludedWarmPaths).toEqual(["/fr/about"]);
  });

  it("discovers concrete getServerSideProps HTML and data identities", async () => {
    writeFile("package.json", JSON.stringify({ type: "module" }));
    writeFile("dist/server/BUILD_ID", "build-a\n");
    writeFile("dist/server/entry.js", "export default {};\n");
    writeFile(
      "pages/gssp.tsx",
      [
        "export async function getServerSideProps() { return { props: {} }; }",
        "export default function Page() { return null; }",
      ].join("\n"),
    );
    const { emitPrerenderPathManifest } =
      await import("../packages/vinext/src/build/prerender-paths.js");

    const manifest = await emitPrerenderPathManifest({ root: tmpDir });

    expect(manifest?.pagesPaths).toEqual(["/gssp"]);
    expect(manifest?.pagesDataPaths).toEqual(["/_next/data/build-a/gssp.json"]);
    expect(manifest?.routePatterns).toEqual({
      "/_next/data/build-a/gssp.json": {
        cacheabilityProbe: { canPrunePattern: true, concretePathname: "/gssp" },
        kind: "pages-page",
        pattern: "/gssp",
      },
      "/gssp": {
        cacheabilityProbe: { canPrunePattern: true },
        kind: "pages-page",
        pattern: "/gssp",
      },
    });
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
