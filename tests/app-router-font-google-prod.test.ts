import fs from "node:fs";
import path from "node:path";
import { createBuilder } from "vite";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import vinext from "../packages/vinext/src/index.js";

describe("App Router Production server self-hosted next/font/google headers", () => {
  // Regression for a bug where vinext's `next/font/google` self-hosting
  // pipeline emitted the dev-machine absolute filesystem path into the
  // HTTP `Link:` response header, the HTML body's `<link rel="preload">`
  // tags, and the `<style data-vinext-fonts>` `@font-face src: url(...)`
  // block. `fetchAndCacheFont` in `packages/vinext/src/plugins/fonts.ts`
  // downloaded Google Fonts `.woff2` files into `<root>/.vinext/fonts/`
  // and wrote `path.join(fontDir, filename)` — an absolute filesystem
  // path — into the cached `@font-face` CSS's `src: url(...)`. The CSS
  // was then embedded verbatim as `selfHostedCSS` in the server bundle
  // and every downstream consumer (the body preload tags, the Link
  // response header, and the injected style block) read the same
  // leaked filesystem path. In production this produced high-priority
  // 404s (`<origin>/home/user/project/.vinext/fonts/...`) on every
  // request and fell back to the real font only via the browser's
  // unrelated runtime retry of the stylesheet CDN.
  //
  // The fix uses a separate fixture (`tests/fixtures/font-google-multiple`)
  // rather than `app-basic` because `app-basic` is shared by many other
  // tests — adding `next/font/google` to its root layout would force a
  // real Google Fonts network fetch into every test run in this file.
  // The mocked fetch below stands in for the Google Fonts CDN so the
  // build is hermetic.
  const FONT_FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/font-google-multiple");
  const fontOutDir = path.resolve(FONT_FIXTURE_DIR, "dist");
  const fontCacheDir = path.resolve(FONT_FIXTURE_DIR, ".vinext");
  const nodeModulesLink = path.join(FONT_FIXTURE_DIR, "node_modules");
  let fontServer: import("node:http").Server | undefined;
  let fontBaseUrl: string;

  beforeAll(async () => {
    // Start from a clean slate so the test deterministically exercises
    // `fetchAndCacheFont`'s fresh-fetch path and the writeBundle copy.
    fs.rmSync(fontOutDir, { recursive: true, force: true });
    fs.rmSync(fontCacheDir, { recursive: true, force: true });

    // The font fixture has no installed node_modules of its own — mirror
    // `font-google-build.test.ts` and symlink the repo-level node_modules
    // so `vinext` resolves as a workspace package during the in-process
    // build below.
    const projectNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    fs.rmSync(nodeModulesLink, { recursive: true, force: true });
    fs.symlinkSync(projectNodeModules, nodeModulesLink);

    // Mock the Google Fonts CDN so the build is hermetic and
    // `fetchAndCacheFont` exercises its real URL-rewrite code path
    // (which used to bake the filesystem path into the cached CSS).
    // The mocked CSS MUST contain `https://fonts.gstatic.com/...` URLs
    // so `fetchAndCacheFont`'s regex extracts them and triggers the
    // `css.split(fontUrl).join(filePath)` rewrite that was the source
    // of the bug. Returning CSS with already-relative URLs would sidestep
    // the failure mode.
    const originalFetch = globalThis.fetch;
    // Normalize every `fetch()` input shape to a plain URL string so the
    // mock can match by substring. The build plugin currently always
    // passes string URLs, but `globalThis.fetch` accepts `RequestInfo |
    // URL` and a future change (or test helper) passing a `Request` or
    // `URL` instance would otherwise be coerced to `[object Request]`
    // by `String()` and silently skip the mock branches, falling through
    // to a real network request for Google Fonts.
    const resolveFetchUrl = (input: unknown): string => {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      if (typeof Request !== "undefined" && input instanceof Request) return input.url;
      return String(input);
    };
    // Preserve `globalThis.fetch`'s full `(input, init)` signature so the
    // fallback path forwards request options verbatim to the real fetch.
    // The build plugin only issues plain GETs for Google Fonts today, so
    // the `init` argument is never populated for the mock branches — but
    // dropping it from the fallback signature would silently strip
    // headers/method/body from any unrelated request that happens to run
    // during the test and fall through.
    globalThis.fetch = async (input: unknown, init?: RequestInit) => {
      const url = resolveFetchUrl(input);
      if (url.includes("fonts.googleapis.com")) {
        const isMono = url.includes("Geist+Mono") || url.includes("Geist%20Mono");
        const family = isMono ? "Geist Mono" : "Geist";
        const gstaticUrl = `https://fonts.gstatic.com/s/${isMono ? "geistmono" : "geist"}/v1/${isMono ? "geistmono" : "geist"}-latin.woff2`;
        const css = [
          "/* latin */",
          "@font-face {",
          `  font-family: '${family}';`,
          "  font-style: normal;",
          "  font-weight: 400;",
          "  font-display: swap;",
          `  src: url(${gstaticUrl}) format('woff2');`,
          "  unicode-range: U+0000-00FF;",
          "}",
        ].join("\n");
        return new Response(css, {
          status: 200,
          headers: { "content-type": "text/css" },
        });
      }
      if (url.includes("fonts.gstatic.com")) {
        // 16 bytes is plenty — the plugin writes whatever it gets to disk
        // under `.vinext/fonts/<family>/<hash>.woff2`. The test never reads
        // the contents back, it only asserts the file exists and serves
        // with the right content-type.
        return new Response(
          new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
          { status: 200, headers: { "content-type": "font/woff2" } },
        );
      }
      return originalFetch(input as RequestInfo, init);
    };

    try {
      const builder = await createBuilder({
        root: FONT_FIXTURE_DIR,
        configFile: false,
        plugins: [vinext({ appDir: FONT_FIXTURE_DIR })],
        logLevel: "silent",
      });
      await builder.buildApp();
    } finally {
      globalThis.fetch = originalFetch;
    }

    const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
    ({ server: fontServer } = await startProdServer({
      port: 0,
      outDir: fontOutDir,
      noCompression: true,
    }));
    const addr = fontServer!.address();
    const port = typeof addr === "object" && addr ? addr.port : 4212;
    fontBaseUrl = `http://localhost:${port}`;
  }, 60000);

  afterAll(() => {
    fontServer?.close();
    fs.rmSync(fontOutDir, { recursive: true, force: true });
    fs.rmSync(fontCacheDir, { recursive: true, force: true });
    fs.rmSync(nodeModulesLink, { recursive: true, force: true });
  });

  it("emits served URLs in the HTTP Link response header (not filesystem paths)", async () => {
    const res = await fetch(`${fontBaseUrl}/`);
    expect(res.status).toBe(200);
    const link = res.headers.get("link");
    expect(link).toBeTruthy();
    // Every preload in the Link header must reference the served URL
    // namespace created by the fix. Before the fix, the header value was
    // `</home/user/project/.vinext/fonts/geist-<hash>/geist-<hash>.woff2>`.
    expect(link).toContain("/_next/static/_vinext_fonts/");
    expect(link).toMatch(/rel=preload/);
    expect(link).toMatch(/as=font/);
    expect(link).toMatch(/type=font\/woff2/);
    // Both the absolute dev-machine prefix and the relative cache dir
    // name must be absent — the leaked path always contained both.
    expect(link).not.toContain(FONT_FIXTURE_DIR);
    expect(link).not.toContain(".vinext/fonts");
  });

  it("emits served URLs in the body <link rel=preload> tags", async () => {
    const res = await fetch(`${fontBaseUrl}/`);
    const html = await res.text();
    expect(html).toMatch(
      /<link rel="preload"[^>]*href="\/_next\/static\/_vinext_fonts\/[^"]+\.woff2"[^>]*as="font"/,
    );
    expect(html).not.toContain(FONT_FIXTURE_DIR);
    expect(html).not.toContain(".vinext/fonts");
  });

  it("emits served URLs in the injected <style data-vinext-fonts> block", async () => {
    // The injected @font-face CSS is the upstream source of truth the body
    // `<link>` tags and HTTP `Link:` header are both derived from — a
    // regression here would reproduce the bug across all three emission
    // paths at once.
    const res = await fetch(`${fontBaseUrl}/`);
    const html = await res.text();
    const styleMatch = html.match(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/);
    expect(styleMatch).not.toBeNull();
    const styleContent = styleMatch![1];
    expect(styleContent).toMatch(/url\(\/_next\/static\/_vinext_fonts\/[^)]+\.woff2\)/);
    expect(styleContent).not.toContain(FONT_FIXTURE_DIR);
    expect(styleContent).not.toContain(".vinext/fonts");
  });

  it("serves the cached font files copied into the client output", async () => {
    // Regression guard for the writeBundle copy hook: without it, the
    // rewritten URLs would be syntactically correct but 404 at request
    // time because the font files never leave `<root>/.vinext/fonts/`.
    const res = await fetch(`${fontBaseUrl}/`);
    const html = await res.text();
    const match = html.match(/\/_next\/static\/_vinext_fonts\/[^"]+\.woff2/);
    expect(match).not.toBeNull();
    const fontPath = match![0];
    const fontRes = await fetch(`${fontBaseUrl}${fontPath}`);
    expect(fontRes.status).toBe(200);
    expect(fontRes.headers.get("content-type")).toBe("font/woff2");
    expect(fontRes.headers.get("cache-control")).toContain("immutable");
  });
});

// ---------------------------------------------------------------------------
// Malformed percent-encoded URL regression tests — App Router dev server
// (covers entries/app-rsc-entry.ts generated RSC handler decodeURIComponent)
// ---------------------------------------------------------------------------
