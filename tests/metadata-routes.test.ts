/**
 * Metadata route generation unit tests.
 *
 * Tests sitemap XML generation, robots.txt generation, manifest JSON
 * generation, and metadata file scanning. These are direct counterparts
 * to Next.js's metadata-dynamic-routes tests, verifying that vinext
 * produces correct output for file-based metadata routes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  sitemapToXml,
  robotsToText,
  manifestToJson,
  scanMetadataFiles,
  METADATA_FILE_MAP,
  type SitemapEntry,
  type RobotsConfig,
  type ManifestConfig,
} from "../packages/vinext/src/server/metadata-routes.js";

// ─── sitemapToXml ───────────────────────────────────────────────────────

describe("sitemapToXml", () => {
  it("generates valid XML for basic entries", () => {
    const entries: SitemapEntry[] = [
      { url: "https://example.com" },
      { url: "https://example.com/about" },
    ];
    const xml = sitemapToXml(entries);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://example.com</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("</urlset>");
  });

  it("generates lastModified from Date", () => {
    const date = new Date("2024-01-15T00:00:00Z");
    const xml = sitemapToXml([{ url: "https://example.com", lastModified: date }]);
    expect(xml).toContain("<lastmod>2024-01-15T00:00:00.000Z</lastmod>");
  });

  it("generates lastModified from string", () => {
    const xml = sitemapToXml([{ url: "https://example.com", lastModified: "2024-01-15" }]);
    expect(xml).toContain("<lastmod>2024-01-15</lastmod>");
  });

  it("generates changeFrequency", () => {
    const xml = sitemapToXml([{ url: "https://example.com", changeFrequency: "weekly" }]);
    expect(xml).toContain("<changefreq>weekly</changefreq>");
  });

  it("generates priority", () => {
    const xml = sitemapToXml([{ url: "https://example.com", priority: 0.8 }]);
    expect(xml).toContain("<priority>0.8</priority>");
  });

  it("generates image entries", () => {
    const xml = sitemapToXml([
      {
        url: "https://example.com",
        images: ["https://example.com/photo1.jpg", "https://example.com/photo2.jpg"],
      },
    ]);
    expect(xml).toContain("<image:image>");
    expect(xml).toContain("<image:loc>https://example.com/photo1.jpg</image:loc>");
    expect(xml).toContain("<image:loc>https://example.com/photo2.jpg</image:loc>");
    expect(xml).toContain("</image:image>");
  });

  it("generates all fields together", () => {
    const xml = sitemapToXml([
      {
        url: "https://example.com/blog",
        lastModified: "2024-06-01",
        changeFrequency: "daily",
        priority: 0.9,
        images: ["https://example.com/hero.jpg"],
      },
    ]);
    expect(xml).toContain("<loc>https://example.com/blog</loc>");
    expect(xml).toContain("<lastmod>2024-06-01</lastmod>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
    expect(xml).toContain("<priority>0.9</priority>");
    expect(xml).toContain("<image:loc>https://example.com/hero.jpg</image:loc>");
  });

  it("generates valid XML for empty entries array", () => {
    const xml = sitemapToXml([]);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });

  it("escapes XML entities in URLs", () => {
    const xml = sitemapToXml([{ url: "https://example.com?a=1&b=2" }]);
    expect(xml).toContain("&amp;");
    expect(xml).not.toMatch(/<loc>[^<]*[^&]&[^a]/); // No unescaped & in loc
  });

  it("escapes angle brackets in text content", () => {
    const xml = sitemapToXml([{ url: "https://example.com/<script>" }]);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).not.toContain("<script>");
  });
});

// ─── robotsToText ───────────────────────────────────────────────────────

describe("robotsToText", () => {
  it("generates basic robots.txt", () => {
    const config: RobotsConfig = {
      rules: { userAgent: "*", allow: "/", disallow: "/private" },
    };
    const txt = robotsToText(config);
    expect(txt).toContain("User-Agent: *");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Disallow: /private");
  });

  it("handles multiple rules", () => {
    const config: RobotsConfig = {
      rules: [
        { userAgent: "Googlebot", allow: "/" },
        { userAgent: "Bingbot", disallow: "/secret" },
      ],
    };
    const txt = robotsToText(config);
    expect(txt).toContain("User-Agent: Googlebot");
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("User-Agent: Bingbot");
    expect(txt).toContain("Disallow: /secret");
  });

  it("handles multiple user agents per rule", () => {
    const config: RobotsConfig = {
      rules: { userAgent: ["Googlebot", "Bingbot"], disallow: "/admin" },
    };
    const txt = robotsToText(config);
    expect(txt).toContain("User-Agent: Googlebot");
    expect(txt).toContain("User-Agent: Bingbot");
    expect(txt).toContain("Disallow: /admin");
  });

  it("handles array allow/disallow", () => {
    const config: RobotsConfig = {
      rules: {
        allow: ["/public", "/docs"],
        disallow: ["/admin", "/api"],
      },
    };
    const txt = robotsToText(config);
    expect(txt).toContain("Allow: /public");
    expect(txt).toContain("Allow: /docs");
    expect(txt).toContain("Disallow: /admin");
    expect(txt).toContain("Disallow: /api");
  });

  it("includes crawl delay", () => {
    const config: RobotsConfig = {
      rules: { crawlDelay: 10 },
    };
    const txt = robotsToText(config);
    expect(txt).toContain("Crawl-delay: 10");
  });

  it("includes sitemap directive", () => {
    const config: RobotsConfig = {
      rules: { allow: "/" },
      sitemap: "https://example.com/sitemap.xml",
    };
    const txt = robotsToText(config);
    expect(txt).toContain("Sitemap: https://example.com/sitemap.xml");
  });

  it("includes multiple sitemaps", () => {
    const config: RobotsConfig = {
      rules: { allow: "/" },
      sitemap: ["https://example.com/sitemap1.xml", "https://example.com/sitemap2.xml"],
    };
    const txt = robotsToText(config);
    expect(txt).toContain("Sitemap: https://example.com/sitemap1.xml");
    expect(txt).toContain("Sitemap: https://example.com/sitemap2.xml");
  });

  it("includes host directive", () => {
    const config: RobotsConfig = {
      rules: { allow: "/" },
      host: "example.com",
    };
    const txt = robotsToText(config);
    expect(txt).toContain("Host: example.com");
  });

  it("defaults user agent to *", () => {
    const config: RobotsConfig = {
      rules: { allow: "/" },
    };
    const txt = robotsToText(config);
    expect(txt).toContain("User-Agent: *");
  });

  it("ends with newline", () => {
    const config: RobotsConfig = { rules: { allow: "/" } };
    const txt = robotsToText(config);
    expect(txt.endsWith("\n")).toBe(true);
  });
});

// ─── manifestToJson ─────────────────────────────────────────────────────

describe("manifestToJson", () => {
  it("generates valid JSON", () => {
    const config: ManifestConfig = {
      name: "My App",
      short_name: "App",
      start_url: "/",
      display: "standalone",
      background_color: "#ffffff",
      theme_color: "#000000",
    };
    const json = manifestToJson(config);
    const parsed = JSON.parse(json);
    expect(parsed.name).toBe("My App");
    expect(parsed.short_name).toBe("App");
    expect(parsed.start_url).toBe("/");
    expect(parsed.display).toBe("standalone");
  });

  it("generates pretty-printed JSON", () => {
    const config: ManifestConfig = { name: "Test" };
    const json = manifestToJson(config);
    // Pretty-printed with 2-space indent
    expect(json).toContain("  ");
    expect(json).toContain("{\n");
  });

  it("handles icons array", () => {
    const config: ManifestConfig = {
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    };
    const parsed = JSON.parse(manifestToJson(config));
    expect(parsed.icons).toHaveLength(2);
    expect(parsed.icons[0].src).toBe("/icon-192.png");
    expect(parsed.icons[1].sizes).toBe("512x512");
  });
});

// ─── scanMetadataFiles ──────────────────────────────────────────────────

describe("scanMetadataFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-test-metadata-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFile(relativePath: string, content = ""): void {
    const fullPath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  it("returns empty array for non-existent directory", () => {
    const routes = scanMetadataFiles("/non/existent/path");
    expect(routes).toEqual([]);
  });

  it("discovers sitemap.xml at root", () => {
    createFile("sitemap.xml");
    const routes = scanMetadataFiles(tmpDir);
    const sitemap = routes.find((r) => r.type === "sitemap");
    expect(sitemap).toBeDefined();
    expect(sitemap!.servedUrl).toBe("/sitemap.xml");
    expect(sitemap!.isDynamic).toBe(false);
    expect(sitemap!.contentType).toBe("application/xml");
  });

  it("discovers dynamic sitemap.ts at root", () => {
    createFile("sitemap.ts");
    const routes = scanMetadataFiles(tmpDir);
    const sitemap = routes.find((r) => r.type === "sitemap");
    expect(sitemap).toBeDefined();
    expect(sitemap!.isDynamic).toBe(true);
    expect(sitemap!.servedUrl).toBe("/sitemap.xml");
  });

  it("discovers robots.txt at root", () => {
    createFile("robots.txt");
    const routes = scanMetadataFiles(tmpDir);
    const robots = routes.find((r) => r.type === "robots");
    expect(robots).toBeDefined();
    expect(robots!.servedUrl).toBe("/robots.txt");
    expect(robots!.contentType).toBe("text/plain");
  });

  it("discovers manifest.webmanifest at root", () => {
    createFile("manifest.webmanifest");
    const routes = scanMetadataFiles(tmpDir);
    const manifest = routes.find((r) => r.type === "manifest");
    expect(manifest).toBeDefined();
    expect(manifest!.servedUrl).toBe("/manifest.webmanifest");
  });

  it("discovers favicon.ico at root", () => {
    createFile("favicon.ico");
    const routes = scanMetadataFiles(tmpDir);
    const favicon = routes.find((r) => r.type === "favicon");
    expect(favicon).toBeDefined();
    expect(favicon!.servedUrl).toBe("/favicon.ico");
    expect(favicon!.contentType).toBe("image/x-icon");
  });

  it("discovers dynamic icon.tsx at root", () => {
    createFile("icon.tsx");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    expect(icon!.isDynamic).toBe(true);
    expect(icon!.servedUrl).toBe("/icon");
  });

  it("discovers static icon.png at root", () => {
    createFile("icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    expect(icon!.isDynamic).toBe(false);
    expect(icon!.contentType).toBe("image/png");
  });

  it("discovers opengraph-image.tsx", () => {
    createFile("opengraph-image.tsx");
    const routes = scanMetadataFiles(tmpDir);
    const og = routes.find((r) => r.type === "opengraph-image");
    expect(og).toBeDefined();
    expect(og!.servedUrl).toBe("/opengraph-image");
  });

  it("discovers twitter-image.jpg", () => {
    createFile("twitter-image.jpg");
    const routes = scanMetadataFiles(tmpDir);
    const twitter = routes.find((r) => r.type === "twitter-image");
    expect(twitter).toBeDefined();
    expect(twitter!.contentType).toBe("image/jpeg");
  });

  it("discovers apple-icon.png", () => {
    createFile("apple-icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const apple = routes.find((r) => r.type === "apple-icon");
    expect(apple).toBeDefined();
    expect(apple!.servedUrl).toBe("/apple-icon");
  });

  it("nestable types discovered in subdirectories", () => {
    createFile("blog/sitemap.xml");
    createFile("blog/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const blogSitemap = routes.find((r) => r.type === "sitemap" && r.servedUrl.includes("blog"));
    expect(blogSitemap).toBeDefined();
    expect(blogSitemap!.servedUrl).toBe("/blog/sitemap.xml");

    const blogIcon = routes.find((r) => r.type === "icon" && r.servedUrl.includes("blog"));
    expect(blogIcon).toBeDefined();
    expect(blogIcon!.servedUrl).toBe("/blog/icon");
  });

  it("non-nestable types only at root", () => {
    createFile("blog/robots.txt");
    createFile("blog/manifest.json");
    createFile("blog/favicon.ico");
    const routes = scanMetadataFiles(tmpDir);
    // robots, manifest, favicon should NOT be found in subdirectories
    expect(routes.find((r) => r.type === "robots")).toBeUndefined();
    expect(routes.find((r) => r.type === "manifest")).toBeUndefined();
    expect(routes.find((r) => r.type === "favicon")).toBeUndefined();
  });

  it("route groups are transparent in URLs", () => {
    createFile("(marketing)/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    // (marketing) should NOT appear in URL
    expect(icon!.servedUrl).toBe("/icon");
    expect(icon!.servedUrl).not.toContain("marketing");
  });

  it("dynamic takes priority over static at same URL", () => {
    createFile("sitemap.xml");
    createFile("sitemap.ts");
    const routes = scanMetadataFiles(tmpDir);
    const sitemaps = routes.filter((r) => r.type === "sitemap");
    // Only one should remain (dynamic wins)
    expect(sitemaps).toHaveLength(1);
    expect(sitemaps[0].isDynamic).toBe(true);
  });

  it("discovers multiple metadata files", () => {
    createFile("sitemap.xml");
    createFile("robots.txt");
    createFile("favicon.ico");
    createFile("icon.tsx");
    createFile("opengraph-image.tsx");
    const routes = scanMetadataFiles(tmpDir);
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(routes.find((r) => r.type === "sitemap")).toBeDefined();
    expect(routes.find((r) => r.type === "robots")).toBeDefined();
    expect(routes.find((r) => r.type === "favicon")).toBeDefined();
    expect(routes.find((r) => r.type === "icon")).toBeDefined();
    expect(routes.find((r) => r.type === "opengraph-image")).toBeDefined();
  });
});

// ─── METADATA_FILE_MAP structure ────────────────────────────────────────

describe("METADATA_FILE_MAP", () => {
  it("has all 8 metadata types", () => {
    expect(Object.keys(METADATA_FILE_MAP)).toEqual(
      expect.arrayContaining([
        "sitemap",
        "robots",
        "manifest",
        "favicon",
        "icon",
        "opengraph-image",
        "twitter-image",
        "apple-icon",
      ]),
    );
  });

  it("favicon is not dynamic-capable", () => {
    expect(METADATA_FILE_MAP.favicon.canBeDynamic).toBe(false);
    expect(METADATA_FILE_MAP.favicon.dynamicExtensions).toEqual([]);
  });

  it("robots is not nestable", () => {
    expect(METADATA_FILE_MAP.robots.nestable).toBe(false);
  });

  it("icon is nestable and dynamic-capable", () => {
    expect(METADATA_FILE_MAP.icon.nestable).toBe(true);
    expect(METADATA_FILE_MAP.icon.canBeDynamic).toBe(true);
    expect(METADATA_FILE_MAP.icon.dynamicExtensions).toContain(".tsx");
  });
});
