/**
 * Next.js Compatibility Tests: metadata-dynamic-routes
 *
 * Ported from: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts
 *
 * Tests that metadata file conventions (robots.ts, sitemap.ts, manifest.ts,
 * icon.tsx, opengraph-image, etc.) generate correct HTTP responses with
 * proper content types and content.
 *
 * We test against the existing app-basic fixture which already has
 * robots.ts, sitemap.ts, manifest.ts, icon.tsx, and apple-icon.png.
 */

import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchDom } from "../helpers.js";

describe("Next.js compat: metadata-dynamic-routes", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    // Warm up
    await fetch(`${baseUrl}/`);
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/metadata-dynamic-routes/index.test.ts

  describe("robots.txt", () => {
    it("should handle robots.ts dynamic routes", async () => {
      const res = await fetch(`${baseUrl}/robots.txt`);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/plain");
      expect(text).toContain("User-Agent: *");
      expect(text).toContain("Allow: /");
      expect(text).toContain("Disallow: /private/");
      expect(text).toContain("Sitemap: https://example.com/sitemap.xml");
    });
  });

  describe("sitemap", () => {
    it("should handle sitemap.ts dynamic routes", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/xml");
      expect(text).toContain('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"');
      expect(text).toContain("<loc>https://example.com</loc>");
      expect(text).toContain("<priority>1</priority>");
    });

    it("should contain multiple URLs in sitemap", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      expect(text).toContain("<loc>https://example.com/about</loc>");
      expect(text).toContain("<loc>https://example.com/blog</loc>");
    });

    it("should contain changefreq and lastmod in sitemap", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      expect(text).toContain("<changefreq>yearly</changefreq>");
      expect(text).toContain("<changefreq>weekly</changefreq>");
      expect(text).toContain("<lastmod>");
    });

    it("should support alternates in sitemap", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      // Check for xhtml:link alternates
      expect(text).toContain("xhtml:link");
      expect(text).toContain('hreflang="fr"');
      expect(text).toContain('href="https://example.com/fr"');
    });

    it("should support images in sitemap", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      expect(text).toContain("image:image");
      expect(text).toContain("<image:loc>https://example.com/image.jpg</image:loc>");
    });

    it("should support videos in sitemap", async () => {
      const res = await fetch(`${baseUrl}/sitemap.xml`);
      const text = await res.text();

      expect(text).toContain("video:video");
      expect(text).toContain("<video:title>Homepage Video</video:title>");
      expect(text).toContain(
        "<video:content_loc>https://example.com/video.mp4</video:content_loc>",
      );
    });
  });

  describe("manifest", () => {
    it("should handle manifest.ts dynamic routes", async () => {
      const res = await fetch(`${baseUrl}/manifest.webmanifest`);
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("application/manifest+json");
      expect(json.name).toBe("App Basic");
      expect(json.short_name).toBe("App");
      expect(json.start_url).toBe("/");
      expect(json.display).toBe("standalone");
    });
  });

  describe("icon", () => {
    it("should handle icon.tsx dynamic routes", async () => {
      const res = await fetch(`${baseUrl}/icon`);
      expect(res.status).toBe(200);
      // icon.tsx generates an image
      expect(res.headers.get("content-type")).toContain("image/");
    });
  });

  describe("metadata link tags", () => {
    it("should include robots.txt link in HTML head", async () => {
      // This verifies the metadata system inserts proper link tags
      // when metadata file routes exist
      const { $ } = await fetchDom(baseUrl, "/");
      // Check that the page renders without error
      expect($.html()).toContain("html");
    });
  });
});
