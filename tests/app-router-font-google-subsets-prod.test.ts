import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

// Regression tests for issue #1897 — `next/font/google` Next.js parity:
//
//  1. The `subsets` option must filter which font files are *preloaded*.
//     Google Fonts CSS responses contain one `@font-face` block per
//     available subset (each annotated with a `/* subset */` comment and a
//     `unicode-range`). Next.js keeps every block in the CSS — browsers
//     only download files whose unicode-range matches page content — but
//     emits `<link rel="preload">` only for files belonging to the
//     requested `subsets` (and nothing when `preload: false`). vinext used
//     to preload every subset's file regardless of the option.
//
//  2. The generated `@font-face` rules must be served as an external,
//     cacheable stylesheet (like Next.js's extracted CSS chunks), not
//     inlined into every HTML response as a `<style data-vinext-fonts>`
//     block.
describe("App Router production server next/font/google subsets + external CSS", () => {
  const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/font-google-subsets");
  const outDir = path.resolve(FIXTURE_DIR, "dist");
  const cacheDir = path.resolve(FIXTURE_DIR, ".vinext");
  const nodeModulesLink = path.join(FIXTURE_DIR, "node_modules");
  let server: import("node:http").Server | undefined;
  let baseUrl: string;

  // Faithful reduction of a real Google Fonts css2 response: one
  // @font-face block per subset, each preceded by a `/* subset */` comment,
  // each pointing at a distinct gstatic file.
  const subsetCss = (family: string, slug: string): string =>
    ["cyrillic", "latin-ext", "latin"]
      .map((subset) =>
        [
          `/* ${subset} */`,
          "@font-face {",
          `  font-family: '${family}';`,
          "  font-style: normal;",
          "  font-weight: 100 900;",
          "  font-display: swap;",
          `  src: url(https://fonts.gstatic.com/s/${slug}/v1/${slug}-${subset}.woff2) format('woff2');`,
          "  unicode-range: U+0000-00FF;",
          "}",
        ].join("\n"),
      )
      .join("\n");

  beforeAll(async () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });

    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    fs.rmSync(nodeModulesLink, { recursive: true, force: true });
    fs.symlinkSync(projectNodeModules, nodeModulesLink);

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
        const isMono = url.includes("Geist+Mono") || url.includes("Geist%20Mono");
        const css = isMono ? subsetCss("Geist Mono", "geistmono") : subsetCss("Geist", "geist");
        return new Response(css, { status: 200, headers: { "content-type": "text/css" } });
      }
      if (url.includes("fonts.gstatic.com")) {
        return new Response(
          new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          { status: 200, headers: { "content-type": "font/woff2" } },
        );
      }
      return originalFetch(input as RequestInfo, init);
    };

    try {
      const builder = await createBuilder({
        root: FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server } = await startProdServer({
      port: 0,
      outDir,
      noCompression: true,
    }));
    const addr = server!.address();
    const port = typeof addr === "object" && addr ? addr.port : 4213;
    baseUrl = `http://localhost:${port}`;
  }, 60000);

  afterAll(() => {
    server?.close();
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(cacheDir, { recursive: true, force: true });
    fs.rmSync(nodeModulesLink, { recursive: true, force: true });
  });

  /** Extract subset → served file URL mapping from served @font-face CSS. */
  function parseSubsetFiles(css: string): Map<string, string> {
    const map = new Map<string, string>();
    let currentSubset = "";
    for (const line of css.split("\n")) {
      const subsetMatch = /^\/\* (.+?) \*\//.exec(line.trim());
      if (subsetMatch) {
        currentSubset = subsetMatch[1];
        continue;
      }
      const urlMatch = /src: url\((.+?)\)/.exec(line);
      if (urlMatch && currentSubset) {
        map.set(currentSubset, urlMatch[1]);
      }
    }
    return map;
  }

  async function getFontStylesheets(html: string): Promise<Map<string, string>> {
    // family stylesheet href -> css content
    const hrefs = [
      ...html.matchAll(/<link rel="stylesheet"[^>]*href="(\/[^"]*_vinext_fonts\/[^"]+\.css)"/g),
    ].map((m) => m[1]);
    const result = new Map<string, string>();
    for (const href of hrefs) {
      const res = await fetch(`${baseUrl}${href}`);
      expect(res.status).toBe(200);
      result.set(href, await res.text());
    }
    return result;
  }

  it("only preloads font files for the requested subsets", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    const preloads = [
      ...html.matchAll(/<link rel="preload"[^>]*href="([^"]+\.woff2)"[^>]*as="font"/g),
    ].map((m) => m[1]);

    // Geist requests only `latin` → exactly one preload. Geist Mono has
    // `preload: false` → zero. Before the fix, all 3 subsets of both
    // families were preloaded (6 links).
    expect(preloads).toHaveLength(1);

    // The single preloaded file must be Geist's latin file. Map served
    // file URLs back to subsets via the external stylesheet's comments.
    const stylesheets = await getFontStylesheets(html);
    const allCss = [...stylesheets.values()].join("\n");
    const geistCss = [...stylesheets.values()].find((css) => css.includes("'Geist'"));
    expect(geistCss).toBeTruthy();
    const subsetFiles = parseSubsetFiles(geistCss!);
    expect(subsetFiles.get("latin")).toBe(preloads[0]);

    // All subsets must still be present in the stylesheet (unicode-range
    // lets the browser pick) — filtering applies to preloads only.
    expect(allCss).toContain("/* cyrillic */");
    expect(allCss).toContain("/* latin-ext */");
    expect(allCss).toContain("/* latin */");
  });

  it("only includes requested-subset files in the HTTP Link header", async () => {
    const res = await fetch(`${baseUrl}/`);
    const linkHeader = res.headers.get("link") ?? "";
    const fontLinks = linkHeader
      .split(",")
      .filter((part) => part.includes("rel=preload") && part.includes("as=font"));
    expect(fontLinks).toHaveLength(1);
    expect(fontLinks[0]).toContain("/_vinext_fonts/");
  });

  it("serves @font-face rules from an external cacheable stylesheet, not inline HTML", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();

    // The HTML must reference external font stylesheets…
    const stylesheets = await getFontStylesheets(html);
    expect(stylesheets.size).toBeGreaterThanOrEqual(1);
    const allCss = [...stylesheets.values()].join("\n");
    expect(allCss).toContain("@font-face");
    expect(allCss).toMatch(/url\(\/_next\/static\/_vinext_fonts\/[^)]+\.woff2\)/);
    expect(allCss).not.toContain(FIXTURE_DIR);

    // …and the stylesheet must be cacheable.
    const href = [...stylesheets.keys()][0];
    const cssRes = await fetch(`${baseUrl}${href}`);
    expect(cssRes.headers.get("content-type")).toContain("text/css");
    expect(cssRes.headers.get("cache-control")).toContain("immutable");

    // No self-hosted @font-face src urls may remain inline in the HTML.
    // (The small class/variable/fallback rules may stay inline; the
    // fallback @font-face uses `src: local(...)`, never `url(...)`.)
    const inlineStyles = [
      ...html.matchAll(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/g),
    ].map((m) => m[1]);
    for (const style of inlineStyles) {
      expect(style).not.toContain("url(");
    }
  });
});
