import path from "node:path";
import fsp from "node:fs/promises";
import type http from "node:http";
import { build } from "vite-plus";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { startProdServer } from "../packages/vinext/src/server/prod-server.js";
import { createIsolatedFixture } from "./helpers.js";

describe("Pages Router Production server self-hosted next/font/google", () => {
  // Pages Router twin of `app-router-font-google-prod.test.ts`. The Pages
  // pipeline has its own font emission sites — `buildPagesFontHeadHtml` in
  // `packages/vinext/src/server/pages-page-response.ts` renders the HTML
  // `<link rel="preload">` tags and the `<style data-vinext-fonts>` block,
  // and `pages-page-handler.ts` builds the HTTP `Link:` response header —
  // so the App Router coverage does not exercise them.
  //
  // Regression for the same ?dpl= bug fixed for the App Router: both Pages
  // sites appended the deployment-id query to the preload hrefs while the
  // `@font-face src: url(...)` was emitted bare. A preload only matches a
  // later font request when the URLs are byte-identical, so every preload
  // was a wasted download and each font re-fetched once the CSS parsed.
  const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/font-google-pages");
  let tmpDir: string;
  let server: http.Server | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await createIsolatedFixture(FIXTURE_DIR, "vinext-pages-font-prod-");
    const outDir = path.join(tmpDir, "dist");

    // Mock the Google Fonts CDN so the build is hermetic and
    // `fetchAndCacheFont` exercises its real URL-rewrite code path. The
    // mocked CSS MUST contain `https://fonts.gstatic.com/...` URLs so the
    // plugin's regex extracts them and rewrites them to served URLs.
    const originalFetch = globalThis.fetch;
    const resolveFetchUrl = (input: unknown): string => {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      if (typeof Request !== "undefined" && input instanceof Request) return input.url;
      return String(input);
    };
    globalThis.fetch = async (input: unknown, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url.includes("fonts.googleapis.com")) {
        const css = [
          "/* latin */",
          "@font-face {",
          "  font-family: 'Geist';",
          "  font-style: normal;",
          "  font-weight: 400;",
          "  font-display: swap;",
          "  src: url(https://fonts.gstatic.com/s/geist/v1/geist-latin.woff2) format('woff2');",
          "  unicode-range: U+0000-00FF;",
          "}",
        ].join("\n");
        return new Response(css, {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }
      if (url.includes("fonts.gstatic.com")) {
        return new Response(
          new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          { status: 200, headers: { "content-type": "font/woff2" } },
        );
      }
      return originalFetch(input as RequestInfo, init);
    };

    // Pin a deploymentId to prove immutable, content-hashed font assets stay
    // query-free across CSS, HTML preloads, and HTTP Link preloads. Next.js
    // clears its client asset token when supportsImmutableAssets applies; its
    // deployment parity fixture exercises this with NEXT_DEPLOYMENT_ID_IMMUTABLE.
    // https://github.com/vercel/next.js/blob/canary/test/production/deployment-id-handling/deployment-id-handling.test.ts
    const plugins = () => [vinext({ nextConfig: () => ({ deploymentId: "dpl-pages-font-prod" }) })];
    try {
      // Pages Router only — no RSC pipeline, so separate build() calls work.
      await build({
        root: tmpDir,
        configFile: false,
        plugins: plugins(),
        logLevel: "silent",
        build: {
          assetsInlineLimit: 0,
          outDir: path.join(outDir, "server"),
          ssr: "virtual:vinext-server-entry",
          rolldownOptions: { output: { entryFileNames: "entry.js" } },
        },
      });
      await build({
        root: tmpDir,
        configFile: false,
        plugins: plugins(),
        logLevel: "silent",
        build: {
          assetsInlineLimit: 0,
          outDir: path.join(outDir, "client"),
          manifest: true,
          ssrManifest: true,
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    ({ server } = await startProdServer({
      port: 0,
      host: "127.0.0.1",
      outDir,
      noCompression: true,
    }));
    const addr = server!.address();
    if (!addr || typeof addr === "string") {
      throw new Error("Failed to start production server for the pages font fixture");
    }
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 60000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }, 15000);

  it("keeps Google and local HTML preload URLs query-free and byte-identical", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const preloadHrefs = [
      ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g),
    ].map((m) => m[1]);
    expect(preloadHrefs.length).toBeGreaterThan(0);
    const googleFontHref = preloadHrefs.find((href) => href.includes("/_vinext_fonts/"));
    const localFontHref = preloadHrefs.find((href) => !href.includes("/_vinext_fonts/"));
    expect(googleFontHref).toBeDefined();
    expect(localFontHref).toBeDefined();
    const styleMatch = html.match(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    for (const href of preloadHrefs) {
      expect(href).not.toContain("?");
      expect(styleMatch![1]).toContain(href);
      if (href === googleFontHref) {
        const fontRes = await fetch(`${baseUrl}${href}`);
        expect(fontRes.status, href).toBe(200);
        expect(fontRes.headers.get("content-type")).toBe("font/woff2");
        expect(fontRes.headers.get("cache-control")).toContain("immutable");
      }
    }
  });

  it("keeps Google and local HTTP Link preload URLs query-free and byte-identical", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const link = res.headers.get("link");
    expect(link).toBeTruthy();
    const html = await res.text();
    const styleMatch = html.match(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const preloadHrefs = [
      ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g),
    ].map((m) => m[1]);
    const linkHrefs = [...link!.matchAll(/<([^>]+)>; rel=preload; as=font/g)].map((m) => m[1]);
    expect(linkHrefs.length).toBeGreaterThan(0);
    expect(linkHrefs.some((href) => href.includes("/_vinext_fonts/"))).toBe(true);
    expect(linkHrefs.some((href) => !href.includes("/_vinext_fonts/"))).toBe(true);
    for (const href of linkHrefs) {
      expect(href).not.toContain("?");
      expect(styleMatch![1]).toContain(href);
      expect(preloadHrefs).toContain(href);
    }
  });
});
