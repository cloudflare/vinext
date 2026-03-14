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
import { resolveSitemap as nextResolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data.js";
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

// Parity guard against Next.js's current sitemap serializer.
// We intentionally compare against the installed implementation because
// several edge cases are surprising but observable in Next itself.
function expectSitemapToMatchNext(entries: SitemapEntry[]): void {
  expect(sitemapToXml(entries)).toBe(nextResolveSitemap(entries));
}

// ─── sitemapToXml ───────────────────────────────────────────────────────

describe("sitemapToXml", () => {
  it("generates valid XML for basic entries", () => {
    const entries: SitemapEntry[] = [
      { url: "https://example.com" },
      { url: "https://example.com/about" },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://example.com</loc>");
    expect(xml).toContain("<loc>https://example.com/about</loc>");
    expect(xml).toContain("</urlset>");
  });

  it("generates lastModified from Date", () => {
    const entries: SitemapEntry[] = [
      { url: "https://example.com", lastModified: new Date("2024-01-15T00:00:00Z") },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<lastmod>2024-01-15T00:00:00.000Z</lastmod>");
  });

  it("generates lastModified from string", () => {
    const entries: SitemapEntry[] = [{ url: "https://example.com", lastModified: "2024-01-15" }];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<lastmod>2024-01-15</lastmod>");
  });

  it("generates changeFrequency", () => {
    const entries: SitemapEntry[] = [{ url: "https://example.com", changeFrequency: "weekly" }];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<changefreq>weekly</changefreq>");
  });

  it("generates priority", () => {
    const entries: SitemapEntry[] = [{ url: "https://example.com", priority: 0.8 }];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<priority>0.8</priority>");
  });

  it("generates image entries", () => {
    const xml = sitemapToXml([
      {
        url: "https://example.com",
        images: ["https://example.com/photo1.jpg", "https://example.com/photo2.jpg"],
      },
    ]);
    expectSitemapToMatchNext([
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

  it("adds the image namespace when image entries are present", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        images: ["https://example.com/photo.jpg"],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
  });

  it("does not add optional namespaces when entries do not use them", () => {
    const entries: SitemapEntry[] = [{ url: "https://example.com" }];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).not.toContain("xmlns:image=");
    expect(xml).not.toContain("xmlns:video=");
    expect(xml).not.toContain("xmlns:xhtml=");
  });

  it("emits alternate-language links with the xhtml namespace", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        alternates: {
          languages: {
            fr: "https://example.com/fr",
            "en-US": "https://example.com/en-US",
          },
        },
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr" />',
    );
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="en-US" href="https://example.com/en-US" />',
    );
  });

  it("adds the xhtml namespace when alternates exists even if languages is empty", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        alternates: {
          languages: {},
        },
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
    expect(xml).not.toContain("<xhtml:link");
  });

  it("emits video entries with the video namespace", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Launch Video",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "Product launch video",
            content_loc: "https://example.com/video.mp4",
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain("<video:video>");
    expect(xml).toContain("<video:title>Launch Video</video:title>");
    expect(xml).toContain(
      "<video:thumbnail_loc>https://example.com/thumb.jpg</video:thumbnail_loc>",
    );
    expect(xml).toContain("<video:description>Product launch video</video:description>");
    expect(xml).toContain("<video:content_loc>https://example.com/video.mp4</video:content_loc>");
    expect(xml).toContain("</video:video>");
  });

  it("emits all supported optional video fields", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Launch Video",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "Product launch video",
            player_loc: "https://example.com/player",
            duration: 120,
            expiration_date: "2024-08-01T12:00:00.000Z",
            rating: 4.5,
            view_count: 42,
            publication_date: "2024-07-01T12:00:00.000Z",
            family_friendly: "yes",
            restriction: { relationship: "allow", content: "US GB" },
            platform: { relationship: "deny", content: "tv" },
            requires_subscription: "no",
            uploader: { info: "https://example.com/authors/jane", content: "Jane Doe" },
            live: "no",
            tag: "launch",
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<video:player_loc>https://example.com/player</video:player_loc>");
    expect(xml).toContain("<video:duration>120</video:duration>");
    expect(xml).toContain(
      "<video:expiration_date>2024-08-01T12:00:00.000Z</video:expiration_date>",
    );
    expect(xml).toContain("<video:rating>4.5</video:rating>");
    expect(xml).toContain("<video:view_count>42</video:view_count>");
    expect(xml).toContain(
      "<video:publication_date>2024-07-01T12:00:00.000Z</video:publication_date>",
    );
    expect(xml).toContain("<video:family_friendly>yes</video:family_friendly>");
    expect(xml).toContain('<video:restriction relationship="allow">US GB</video:restriction>');
    expect(xml).toContain('<video:platform relationship="deny">tv</video:platform>');
    expect(xml).toContain("<video:requires_subscription>no</video:requires_subscription>");
    expect(xml).toContain(
      '<video:uploader info="https://example.com/authors/jane">Jane Doe</video:uploader>',
    );
    expect(xml).toContain("<video:live>no</video:live>");
    expect(xml).toContain("<video:tag>launch</video:tag>");
  });

  it("escapes XML-sensitive values instead of raw-interpolating them", () => {
    // Next.js raw-interpolates these values, producing invalid XML.
    // vinext intentionally diverges to produce well-formed XML that
    // search engines can actually parse.
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com?a=1&b=2",
        alternates: {
          languages: {
            'fr"CA': "https://example.com/fr?a=1&b=2",
          },
        },
        videos: [
          {
            title: 'Fish & "Chips"',
            thumbnail_loc: "https://example.com/thumb.jpg?a=1&b=2",
            description: "Tasty <b>meal</b>",
            uploader: {
              info: 'https://example.com/authors/jane?bio="yes"&x=1',
              content: "Jane & Co",
            },
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expect(xml).toContain("<loc>https://example.com?a=1&amp;b=2</loc>");
    expect(xml).toContain('href="https://example.com/fr?a=1&amp;b=2"');
    expect(xml).toContain("<video:title>Fish &amp; &quot;Chips&quot;</video:title>");
    expect(xml).toContain("<video:description>Tasty &lt;b&gt;meal&lt;/b&gt;</video:description>");
    expect(xml).toContain(
      '<video:uploader info="https://example.com/authors/jane?bio=&quot;yes&quot;&amp;x=1">Jane &amp; Co</video:uploader>',
    );
  });

  it("emits all namespaces together when mixed entries require them", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        alternates: { languages: { fr: "https://example.com/fr" } },
        images: ["https://example.com/photo.jpg"],
        videos: [
          {
            title: "Launch Video",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "Product launch video",
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
    expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
  });

  it("generates all fields together", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com/blog",
        lastModified: "2024-06-01",
        changeFrequency: "daily",
        priority: 0.9,
        alternates: { languages: { fr: "https://example.com/fr/blog" } },
        images: ["https://example.com/hero.jpg"],
        videos: [
          {
            title: "Blog Video",
            thumbnail_loc: "https://example.com/video-thumb.jpg",
            description: "Blog teaser",
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain("<loc>https://example.com/blog</loc>");
    expect(xml).toContain("<lastmod>2024-06-01</lastmod>");
    expect(xml).toContain("<changefreq>daily</changefreq>");
    expect(xml).toContain("<priority>0.9</priority>");
    expect(xml).toContain(
      '<xhtml:link rel="alternate" hreflang="fr" href="https://example.com/fr/blog" />',
    );
    expect(xml).toContain("<image:loc>https://example.com/hero.jpg</image:loc>");
    expect(xml).toContain("<video:title>Blog Video</video:title>");
    expect(xml.indexOf("<xhtml:link")).toBeLessThan(xml.indexOf("<image:image>"));
    expect(xml.indexOf("<image:image>")).toBeLessThan(xml.indexOf("<video:video>"));
    expect(xml.indexOf("<video:video>")).toBeLessThan(xml.indexOf("<lastmod>"));
  });

  it("generates valid XML for empty entries array", () => {
    const entries: SitemapEntry[] = [];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });

  it("omits zero-valued optional video numerics like Next", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Zeroes",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "desc",
            duration: 0,
            rating: 0,
            view_count: 0,
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).not.toContain("<video:duration>0</video:duration>");
    expect(xml).not.toContain("<video:rating>0</video:rating>");
    expect(xml).not.toContain("<video:view_count>0</video:view_count>");
  });

  it("matches Next when uploader content is missing", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Uploader",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "desc",
            uploader: {
              info: "https://example.com/uploader",
            },
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expectSitemapToMatchNext(entries);
    expect(xml).toContain(
      '<video:uploader info="https://example.com/uploader">undefined</video:uploader>',
    );
  });

  it("matches Next when video date fields are Date objects", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Dates",
            thumbnail_loc: "https://example.com/thumb.jpg",
            description: "desc",
            expiration_date: new Date("2024-08-01T12:00:00Z"),
            publication_date: new Date("2024-07-01T12:00:00Z"),
          },
        ],
      },
    ];
    expectSitemapToMatchNext(entries);
  });

  it("escapes XML special characters in URLs and text content", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com/search?q=a&b=2",
        images: ["https://example.com/img?w=100&h=200"],
        alternates: {
          languages: {
            de: "https://example.com/de/search?q=a&b=2",
          },
        },
      },
    ];
    const xml = sitemapToXml(entries);
    // Bare & must be escaped as &amp; in XML
    expect(xml).toContain("<loc>https://example.com/search?q=a&amp;b=2</loc>");
    expect(xml).toContain("<image:loc>https://example.com/img?w=100&amp;h=200</image:loc>");
    expect(xml).toContain('href="https://example.com/de/search?q=a&amp;b=2"');
    // Must NOT contain bare & followed by a non-amp; entity
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("escapes XML special characters in video fields", () => {
    const entries: SitemapEntry[] = [
      {
        url: "https://example.com",
        videos: [
          {
            title: "Tom & Jerry <2>",
            thumbnail_loc: "https://example.com/thumb?a=1&b=2",
            description: 'He said "hello" & <goodbye>',
          },
        ],
      },
    ];
    const xml = sitemapToXml(entries);
    expect(xml).toContain("<video:title>Tom &amp; Jerry &lt;2&gt;</video:title>");
    expect(xml).toContain(
      "<video:thumbnail_loc>https://example.com/thumb?a=1&amp;b=2</video:thumbnail_loc>",
    );
    expect(xml).toContain(
      "<video:description>He said &quot;hello&quot; &amp; &lt;goodbye&gt;</video:description>",
    );
  });
});

// ─── robotsToText ────────────────────────────────────────────────────────

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

  it("route groups get a unique metadata suffix", () => {
    createFile("(marketing)/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    expect(icon!.servedUrl).toMatch(/^\/icon-[0-9a-z]{6}$/);
    expect(icon!.servedUrl).not.toContain("marketing");
  });

  it("parallel slot directories get a unique metadata suffix", () => {
    createFile("@modal/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    expect(icon!.servedUrl).toMatch(/^\/icon-[0-9a-z]{6}$/);
    expect(icon!.servedUrl).not.toContain("@modal");
  });

  it("@children does not get a metadata suffix", () => {
    createFile("@children/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icon = routes.find((r) => r.type === "icon");
    expect(icon).toBeDefined();
    expect(icon!.servedUrl).toBe("/icon");
  });

  it("skips metadata files inside private folders", () => {
    createFile("_private/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    expect(routes).toEqual([]);
  });

  it("root metadata and parallel slot metadata get distinct URLs", () => {
    createFile("icon.png");
    createFile("@modal/icon.png");
    const routes = scanMetadataFiles(tmpDir);
    const icons = routes.filter((r) => r.type === "icon");
    expect(icons).toHaveLength(2);
    expect(icons.some((icon) => icon.servedUrl === "/icon")).toBe(true);
    expect(icons.some((icon) => /^\/icon-[0-9a-z]{6}$/.test(icon.servedUrl))).toBe(true);
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
