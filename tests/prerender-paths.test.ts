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
        return new Response("null", { headers: { "content-type": "application/json" } });
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

    const manifest = await emitPrerenderPathManifest({ root: tmpDir, responseVary: "verbatim" });

    expect(manifest).toEqual({
      buildId: "build-a",
      buildIdentity: "rsc-build-a",
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
    expect(startProdServerMock).toHaveBeenCalledOnce();
    expect(startProdServerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rscEntryPath: toSlash(path.join(tmpDir, "dist/server/index.js")),
      }),
    );
    expect(closeMock).toHaveBeenCalledOnce();
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

  it("excludes Pages-owned hybrid paths from App RSC warm discovery", async () => {
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

    expect(manifest?.paths).toEqual([
      "/pages-dir/static",
      "/pages-dir/foobar",
      "/api/status",
      "/specific/value",
    ]);
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
      "/api/status",
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
    expect(manifest?.rscPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.loadingShellPaths).toEqual(["/fr/api/status"]);
    expect(manifest?.pagesPaths).toEqual(["/about"]);
  });

  it("skips dynamic warmup paths when static params discovery aborts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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

    const manifest = await emitPrerenderPathManifest({ root: tmpDir });

    expect(manifest?.paths).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to discover warmup path(s) for /cached/:slug"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out after 30000ms"));
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
