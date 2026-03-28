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
    expiration_date?: string | Date;
    rating?: number;
    view_count?: number;
    publication_date?: string | Date;
    family_friendly?: "yes" | "no";
    restriction?: { relationship: "allow" | "deny"; content: string };
    platform?: { relationship: "allow" | "deny"; content: string };
    requires_subscription?: "yes" | "no";
    uploader?: {
      info?: string;
      content?: string;
    };
    live?: "yes" | "no";
    tag?: string;
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

/** Escape the five XML special characters in text content and attribute values. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Convert a sitemap array to XML string.
 */
export function sitemapToXml(entries: SitemapEntry[]): string {
  const hasAlternates = entries.some((entry) => Object.keys(entry.alternates ?? {}).length > 0);
  const hasImages = entries.some((entry) => Boolean(entry.images?.length));
  const hasVideos = entries.some((entry) => Boolean(entry.videos?.length));
  let content = "";

  content += '<?xml version="1.0" encoding="UTF-8"?>\n';
  content += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
  if (hasImages) {
    content += ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"';
  }
  if (hasVideos) {
    content += ' xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"';
  }
  if (hasAlternates) {
    content += ' xmlns:xhtml="http://www.w3.org/1999/xhtml">\n';
  } else {
    content += ">\n";
  }

  for (const entry of entries) {
    content += "<url>\n";
    content += `<loc>${escapeXml(entry.url)}</loc>\n`;

    const languages = entry.alternates?.languages;
    if (languages && Object.keys(languages).length) {
      for (const language in languages) {
        content += `<xhtml:link rel="alternate" hreflang="${escapeXml(language)}" href="${escapeXml(languages[language])}" />\n`;
      }
    }

    if (entry.images?.length) {
      for (const image of entry.images) {
        content += `<image:image>\n<image:loc>${escapeXml(image)}</image:loc>\n</image:image>\n`;
      }
    }

    if (entry.videos?.length) {
      for (const video of entry.videos) {
        const videoFields = [
          "<video:video>",
          `<video:title>${escapeXml(String(video.title))}</video:title>`,
          `<video:thumbnail_loc>${escapeXml(String(video.thumbnail_loc))}</video:thumbnail_loc>`,
          `<video:description>${escapeXml(String(video.description))}</video:description>`,
          video.content_loc &&
            `<video:content_loc>${escapeXml(String(video.content_loc))}</video:content_loc>`,
          video.player_loc &&
            `<video:player_loc>${escapeXml(String(video.player_loc))}</video:player_loc>`,
          video.duration && `<video:duration>${video.duration}</video:duration>`,
          video.view_count && `<video:view_count>${video.view_count}</video:view_count>`,
          video.tag && `<video:tag>${escapeXml(String(video.tag))}</video:tag>`,
          video.rating && `<video:rating>${video.rating}</video:rating>`,
          video.expiration_date &&
            `<video:expiration_date>${escapeXml(String(video.expiration_date))}</video:expiration_date>`,
          video.publication_date &&
            `<video:publication_date>${escapeXml(String(video.publication_date))}</video:publication_date>`,
          video.family_friendly &&
            `<video:family_friendly>${video.family_friendly}</video:family_friendly>`,
          video.requires_subscription &&
            `<video:requires_subscription>${video.requires_subscription}</video:requires_subscription>`,
          video.live && `<video:live>${video.live}</video:live>`,
          video.restriction &&
            `<video:restriction relationship="${escapeXml(String(video.restriction.relationship))}">${escapeXml(String(video.restriction.content))}</video:restriction>`,
          video.platform &&
            `<video:platform relationship="${escapeXml(String(video.platform.relationship))}">${escapeXml(String(video.platform.content))}</video:platform>`,
          video.uploader &&
            `<video:uploader${video.uploader.info ? ` info="${escapeXml(String(video.uploader.info))}"` : ""}>${escapeXml(String(video.uploader.content))}</video:uploader>`,
          "</video:video>\n",
        ].filter(Boolean);
        content += videoFields.join("\n");
      }
    }

    if (entry.lastModified) {
      content += `<lastmod>${serializeDate(entry.lastModified)}</lastmod>\n`;
    }
    if (entry.changeFrequency) {
      content += `<changefreq>${entry.changeFrequency}</changefreq>\n`;
    }
    if (typeof entry.priority === "number") {
      content += `<priority>${entry.priority}</priority>\n`;
    }
    content += "</url>\n";
  }

  content += "</urlset>\n";
  return content;
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

function serializeDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
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

function metadataRouteSuffix(parentSegments: string[], metaType: string): string {
  if (metaType === "sitemap" || metaType === "robots" || metaType === "manifest") {
    // Sitemap is exempt per Next.js. Robots and manifest are also safe to
    // exempt because they are root-only in vinext, so invisible parents never apply.
    return "";
  }

  const hasInvisibleParent = parentSegments.some(
    (segment) =>
      (segment.startsWith("(") && segment.endsWith(")")) ||
      (segment.startsWith("@") && segment !== "@children"),
  );
  if (!hasInvisibleParent) return "";

  const parentPath = `/${parentSegments.join("/")}`;
  let hash = 5381;
  for (let i = 0; i < parentPath.length; i++) {
    hash = ((hash << 5) + hash + parentPath.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function withMetadataSuffix(urlPath: string, suffix: string): string {
  if (!suffix) return urlPath;
  const parsed = path.posix.parse(urlPath);
  return path.posix.join(parsed.dir || "/", `${parsed.name}-${suffix}${parsed.ext}`);
}

/**
 * Scan an app directory for metadata files.
 */
export function scanMetadataFiles(appDir: string): MetadataFileRoute[] {
  const routes: MetadataFileRoute[] = [];

  // Scan the app directory recursively
  function scan(dir: string, urlPrefix: string, parentSegments: string[]): void {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirName = entry.name;
        if (dirName.startsWith("_")) continue;

        const isRouteGroup = dirName.startsWith("(") && dirName.endsWith(")");
        const isParallelRoute = dirName.startsWith("@");
        const nextUrlPrefix =
          isRouteGroup || isParallelRoute ? urlPrefix : `${urlPrefix}/${dirName}`;
        scan(path.join(dir, dirName), nextUrlPrefix, [...parentSegments, dirName]);
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
        const suffix = metadataRouteSuffix(parentSegments, metaType);
        const urlPath = withMetadataSuffix(config.urlPath, suffix);

        routes.push({
          type: metaType,
          isDynamic,
          filePath: path.join(dir, fileName),
          servedUrl: urlPrefix === "" ? urlPath : `${urlPrefix}${urlPath}`,
          contentType: isStatic
            ? getStaticContentType(ext, config.contentType)
            : config.contentType,
        });
      }
    }
  }

  scan(appDir, "", []);

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
