import fsp from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  createPagesFontFixture,
  startPagesFontDevelopment,
  startPagesFontProduction,
} from "./pages-font-google-fixture.js";

function expectGoogleFontFallbacks(html: string, assetsDir: string): void {
  // Ported from Next.js: test/e2e/next-font/index.test.ts
  // https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/index.test.ts
  const css = html.match(/<style data-vinext-fonts[^>]*>([\s\S]*?)<\/style>/)?.[1];
  expect(css).toBeDefined();
  expect(css).toMatch(
    /\.__font_geist_\w+ \{ font-family: 'Geist', 'Geist Fallback', system-ui, 'Arial';/,
  );
  expect(css).toMatch(/\.__font_open_sans_\w+ \{ font-family: 'Open Sans';/);
  expect(css).toMatch(/\.__font_roboto_\w+ \{ font-family: 'Roboto', system-ui, 'Arial';/);
  expect(css).toMatch(/@font-face\s*\{[^}]*font-family: 'Geist Fallback';[^}]*size-adjust:/);
  expect(css).not.toContain("'Open Sans Fallback'");
  expect(css).not.toContain("'Roboto Fallback'");

  const allPreloads = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].map(
    ([link]) => link,
  );
  const preloads = allPreloads.filter((link) =>
    link.includes(`href="/${assetsDir}/_vinext_fonts/`),
  );
  expect(preloads, allPreloads.join("\n")).toHaveLength(3);
  expect(preloads.find((link) => link.includes("/geist-"))).toContain(
    'data-next-font="size-adjust"',
  );
  expect(preloads.find((link) => link.includes("/open-sans-"))).toContain('data-next-font=""');
  expect(preloads.find((link) => link.includes("/roboto-"))).toContain('data-next-font=""');
}

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
  let tmpDir: string;
  let server: Awaited<ReturnType<typeof startPagesFontProduction>> | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    tmpDir = await createPagesFontFixture();
    server = await startPagesFontProduction(tmpDir);
    baseUrl = server.url;
  }, 60000);

  afterAll(async () => {
    await server?.close();
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
    const localFontFace = styleMatch![1]
      .match(/@font-face\s*\{[^}]*\}/g)
      ?.find((fontFace) => fontFace.includes(localFontHref!));
    expect(localFontFace).toBeDefined();
    expect(localFontFace).not.toContain("font-weight:");
    // The fixture mirrors #2793's 400/600/700 reproduction. Its omitted
    // local-font weight also matches the equivalent Next.js fixture:
    // test/e2e/next-font/app/pages/with-local-fonts.js
    // https://github.com/vercel/next.js/blob/canary/test/e2e/next-font/app/pages/with-local-fonts.js
    for (const weight of ["400", "600", "700"]) {
      expect(html).toContain(`data-local-font-weight="${weight}"`);
    }
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

  it("keeps Google fallback styles and preload metadata in production", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expectGoogleFontFallbacks(await res.text(), "_next/static");
  });

  it("keeps Google fallback styles and preload metadata in development", async () => {
    const devServer = await startPagesFontDevelopment(tmpDir);
    try {
      const res = await fetch(devServer.url);
      expect(res.status).toBe(200);
      expectGoogleFontFallbacks(await res.text(), "font-dev/_next/static");
    } finally {
      await devServer.close();
    }
  }, 60000);
});
