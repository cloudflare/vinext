/**
 * File-based metadata route handling.
 *
 * Next.js supports special files in the app/ directory that auto-generate
 * metadata routes:
 *   - sitemap.ts/.xml → /sitemap.xml (application/xml)
 *   - robots.ts/.txt  → /robots.txt  (text/plain)
 *   - manifest.ts/.json/.webmanifest → /manifest.webmanifest (application/manifest+json)
 *   - icon.tsx/.png   → /icon (image/*)
 *   - opengraph-image.tsx/.png → /opengraph-image (image/*)
 *   - twitter-image.tsx/.png → /twitter-image (image/*)
 *   - apple-icon.tsx/.png → /apple-icon (image/*)
 *   - favicon.ico → /favicon.ico (image/x-icon)
 *
 * Dynamic versions (ts/tsx/js) export a default function that returns the data.
 * Static versions (xml/txt/json/png/etc.) are served as-is.
 */
import fs from "node:fs";
import path from "node:path";

// -------------------------------------------------------------------
// Types matching Next.js MetadataRoute
// -------------------------------------------------------------------

export interface SitemapEntry {
  url: string;
  lastModified?: string | Date;
  changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
  alternates?: {
    languages?: Record<string, string>;
  };
  images?: string[];
  videos?: Array<{
    title: string;
    thumbnail_loc: string;
    description: string;
    content_loc?: string;
    player_loc?: string;
    duration?: number;
    expiration_date?: string;
    rating?: number;
    view_count?: number;
    publication_date?: string;
    family_friendly?: "yes" | "no";
    restriction?: { relationship: "allow" | "deny"; content: string };
    platform?: { relationship: "allow" | "deny"; content: string };
    live?: "yes" | "no";
  }>;
}

export interface RobotsRule {
  userAgent?: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
  crawlDelay?: number;
}

export interface RobotsConfig {
  rules: RobotsRule | RobotsRule[];
  sitemap?: string | string[];
  host?: string;
}

export interface ManifestConfig {
  name?: string;
  short_name?: string;
  description?: string;
  start_url?: string;
  display?: "fullscreen" | "standalone" | "minimal-ui" | "browser";
  background_color?: string;
  theme_color?: string;
  icons?: Array<{
    src: string;
    sizes?: string;
    type?: string;
    purpose?: string;
  }>;
  [key: string]: unknown;
}

// -------------------------------------------------------------------
// Known metadata file patterns
// -------------------------------------------------------------------

/** Map of metadata file base names to their URL path and content type. */
export const METADATA_FILE_MAP: Record<
  string,
  {
    /** URL path this file is served at */
    urlPath: string;
    /** Content type for the response */
    contentType: string;
    /** Whether this can be dynamic (.ts/.tsx/.js) */
    canBeDynamic: boolean;
    /** File extensions for static variants */
    staticExtensions: string[];
    /** File extensions for dynamic variants */
    dynamicExtensions: string[];
    /** Whether this can be nested in sub-segments */
    nestable: boolean;
  }
> = {
  sitemap: {
    urlPath: "/sitemap.xml",
    contentType: "application/xml",
    canBeDynamic: true,
    staticExtensions: [".xml"],
    dynamicExtensions: [".ts", ".js"],
    nestable: true,
  },
  robots: {
    urlPath: "/robots.txt",
    contentType: "text/plain",
    canBeDynamic: true,
    staticExtensions: [".txt"],
    dynamicExtensions: [".ts", ".js"],
    nestable: false,
  },
  manifest: {
    urlPath: "/manifest.webmanifest",
    contentType: "application/manifest+json",
    canBeDynamic: true,
    staticExtensions: [".json", ".webmanifest"],
    dynamicExtensions: [".ts", ".js"],
    nestable: false,
  },
  favicon: {
    urlPath: "/favicon.ico",
    contentType: "image/x-icon",
    canBeDynamic: false,
    staticExtensions: [".ico"],
    dynamicExtensions: [],
    nestable: false,
  },
  icon: {
    urlPath: "/icon",
    contentType: "image/png",
    canBeDynamic: true,
    staticExtensions: [".ico", ".jpg", ".jpeg", ".png", ".svg"],
    dynamicExtensions: [".ts", ".tsx", ".js"],
    nestable: true,
  },
  "opengraph-image": {
    urlPath: "/opengraph-image",
    contentType: "image/png",
    canBeDynamic: true,
    staticExtensions: [".jpg", ".jpeg", ".png", ".gif"],
    dynamicExtensions: [".ts", ".tsx", ".js"],
    nestable: true,
  },
  "twitter-image": {
    urlPath: "/twitter-image",
    contentType: "image/png",
    canBeDynamic: true,
    staticExtensions: [".jpg", ".jpeg", ".png", ".gif"],
    dynamicExtensions: [".ts", ".tsx", ".js"],
    nestable: true,
  },
  "apple-icon": {
    urlPath: "/apple-icon",
    contentType: "image/png",
    canBeDynamic: true,
    staticExtensions: [".jpg", ".jpeg", ".png"],
    dynamicExtensions: [".ts", ".tsx", ".js"],
    nestable: true,
  },
};

// -------------------------------------------------------------------
// Serializers
// -------------------------------------------------------------------

/**
 * Convert a sitemap array to XML string.
 */
export function sitemapToXml(entries: SitemapEntry[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];

  for (const entry of entries) {
    lines.push("  <url>");
    lines.push(`    <loc>${escapeXml(entry.url)}</loc>`);

    if (entry.lastModified) {
      const date =
        entry.lastModified instanceof Date ? entry.lastModified.toISOString() : entry.lastModified;
      lines.push(`    <lastmod>${escapeXml(date)}</lastmod>`);
    }

    if (entry.changeFrequency) {
      lines.push(`    <changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`);
    }

    if (entry.priority !== undefined) {
      lines.push(`    <priority>${entry.priority}</priority>`);
    }

    if (entry.images) {
      for (const image of entry.images) {
        lines.push("    <image:image>");
        lines.push(`      <image:loc>${escapeXml(image)}</image:loc>`);
        lines.push("    </image:image>");
      }
    }

    lines.push("  </url>");
  }

  lines.push("</urlset>");
  return lines.join("\n");
}

/**
 * Convert a robots config to text format.
 */
export function robotsToText(config: RobotsConfig): string {
  const lines: string[] = [];
  const rules = Array.isArray(config.rules) ? config.rules : [config.rules];

  for (const rule of rules) {
    const agents = Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent ?? "*"];

    for (const agent of agents) {
      lines.push(`User-Agent: ${agent}`);
    }

    if (rule.allow) {
      const allows = Array.isArray(rule.allow) ? rule.allow : [rule.allow];
      for (const allow of allows) {
        lines.push(`Allow: ${allow}`);
      }
    }

    if (rule.disallow) {
      const disallows = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
      for (const disallow of disallows) {
        lines.push(`Disallow: ${disallow}`);
      }
    }

    if (rule.crawlDelay !== undefined) {
      lines.push(`Crawl-delay: ${rule.crawlDelay}`);
    }

    lines.push("");
  }

  if (config.sitemap) {
    const sitemaps = Array.isArray(config.sitemap) ? config.sitemap : [config.sitemap];
    for (const sitemap of sitemaps) {
      lines.push(`Sitemap: ${sitemap}`);
    }
  }

  if (config.host) {
    lines.push(`Host: ${config.host}`);
  }

  return lines.join("\n").trim() + "\n";
}

/**
 * Convert a manifest config to JSON string.
 */
export function manifestToJson(config: ManifestConfig): string {
  return JSON.stringify(config, null, 2);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -------------------------------------------------------------------
// Metadata route discovery
// -------------------------------------------------------------------

export interface MetadataFileRoute {
  /** Type of metadata file */
  type: string;
  /** Whether this is a dynamic (code-generated) route */
  isDynamic: boolean;
  /** Absolute file path */
  filePath: string;
  /** URL path this file is served at */
  servedUrl: string;
  /** Content type for the response */
  contentType: string;
}

/**
 * Scan an app directory for metadata files.
 */
export function scanMetadataFiles(appDir: string): MetadataFileRoute[] {
  const routes: MetadataFileRoute[] = [];

  // Scan the app directory recursively
  function scan(dir: string, urlPrefix: string): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Skip route group parentheses from URL
        const dirName = entry.name;
        const isRouteGroup = dirName.startsWith("(") && dirName.endsWith(")");
        const nextUrlPrefix = isRouteGroup ? urlPrefix : `${urlPrefix}/${dirName}`;
        scan(path.join(dir, dirName), nextUrlPrefix);
        continue;
      }

      // Check each metadata file pattern
      const fileName = entry.name;
      const baseName = fileName.replace(/\.[^.]+$/, "");
      const ext = fileName.slice(baseName.length);

      for (const [metaType, config] of Object.entries(METADATA_FILE_MAP)) {
        // Check if the base name matches
        if (baseName !== metaType) continue;

        // Check nestability — non-nestable types only at root
        if (!config.nestable && urlPrefix !== "") continue;

        // Check if this is a static or dynamic variant
        const isStatic = config.staticExtensions.includes(ext);
        const isDynamic = config.dynamicExtensions.includes(ext);

        if (!isStatic && !isDynamic) continue;

        routes.push({
          type: metaType,
          isDynamic,
          filePath: path.join(dir, fileName),
          servedUrl: urlPrefix === "" ? config.urlPath : `${urlPrefix}${config.urlPath}`,
          contentType: isStatic
            ? getStaticContentType(ext, config.contentType)
            : config.contentType,
        });
      }
    }
  }

  scan(appDir, "");

  // Deduplicate: if both dynamic and static variants exist at the same URL,
  // keep only the dynamic one (matches Next.js behavior).
  const byUrl = new Map<string, MetadataFileRoute>();
  for (const route of routes) {
    const existing = byUrl.get(route.servedUrl);
    if (!existing) {
      byUrl.set(route.servedUrl, route);
    } else if (route.isDynamic && !existing.isDynamic) {
      // Dynamic takes priority over static
      byUrl.set(route.servedUrl, route);
    }
    // If both are static or both dynamic, keep the first one found
  }
  return Array.from(byUrl.values());
}

function getStaticContentType(ext: string, fallback: string): string {
  const map: Record<string, string> = {
    ".xml": "application/xml",
    ".txt": "text/plain",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
  };
  return map[ext] ?? fallback;
}
