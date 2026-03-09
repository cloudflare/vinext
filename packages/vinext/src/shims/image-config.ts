/**
 * Shared next/image config types and matcher helpers.
 *
 * This module intentionally mirrors the public Next.js image config surface,
 * but uses vinext's optimizer path as the default.
 */

export const VALID_LOADERS = ["default", "imgix", "cloudinary", "akamai", "custom"] as const;

export type LoaderValue = (typeof VALID_LOADERS)[number];

export type ImageLoaderProps = {
  src: string;
  width: number;
  quality?: number;
};

export type ImageLoaderPropsWithConfig = ImageLoaderProps & {
  config: Readonly<ImageConfigComplete>;
};

export interface LocalPattern {
  pathname?: string;
  search?: string;
}

export interface RemotePattern {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
  search?: string;
}

export type ImageFormat = "image/avif" | "image/webp";

export interface ImageConfigComplete {
  deviceSizes: number[];
  imageSizes: number[];
  loader: LoaderValue;
  path: string;
  loaderFile: string;
  domains: string[];
  disableStaticImages: boolean;
  minimumCacheTTL: number;
  formats: ImageFormat[];
  maximumDiskCacheSize: number | undefined;
  maximumRedirects: number;
  maximumResponseBody: number;
  dangerouslyAllowLocalIP: boolean;
  dangerouslyAllowSVG: boolean;
  contentSecurityPolicy: string;
  contentDispositionType: "inline" | "attachment";
  remotePatterns: Array<URL | RemotePattern>;
  localPatterns: LocalPattern[] | undefined;
  qualities: number[] | undefined;
  unoptimized: boolean;
  customCacheHandler: boolean;
}

export type ImageConfig = Partial<ImageConfigComplete>;

export const imageConfigDefault: ImageConfigComplete = {
  deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
  imageSizes: [32, 48, 64, 96, 128, 256, 384],
  path: "/_vinext/image",
  loader: "default",
  loaderFile: "",
  domains: [],
  disableStaticImages: false,
  minimumCacheTTL: 14_400, // 4 hours — matches Next.js 16 default (image-config.ts:160)
  formats: ["image/webp"],
  maximumDiskCacheSize: undefined,
  maximumRedirects: 3,
  maximumResponseBody: 50_000_000,
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: "attachment",
  localPatterns: undefined,
  remotePatterns: [],
  qualities: [75],
  unoptimized: false,
  customCacheHandler: false,
};

function escapeRegex(source: string): string {
  return source.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern using `*` / `**` into a regular expression.
 * The semantics intentionally follow Next's hostname/path matchers.
 */
function globToRegex(pattern: string, separator: "." | "/"): RegExp {
  const anyDepth = separator === "." ? ".+" : ".*";
  const singleDepth = separator === "." ? "[^.]+" : "[^/]+";

  let regex = "^";
  const parts = pattern.split("**");
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) regex += anyDepth;
    const subParts = parts[i].split("*");
    for (let j = 0; j < subParts.length; j++) {
      if (j > 0) regex += singleDepth;
      regex += escapeRegex(subParts[j]);
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function toRemotePattern(pattern: URL | RemotePattern): RemotePattern {
  if (pattern instanceof URL) {
    return {
      protocol: pattern.protocol.replace(/:$/, "") as "http" | "https",
      hostname: pattern.hostname,
      port: pattern.port,
      pathname: pattern.pathname,
      search: pattern.search,
    };
  }
  return pattern;
}

export function matchRemotePattern(patternLike: URL | RemotePattern, url: URL): boolean {
  const pattern = toRemotePattern(patternLike);

  if (pattern.protocol !== undefined) {
    if (pattern.protocol.replace(/:$/, "") !== url.protocol.replace(/:$/, "")) {
      return false;
    }
  }
  if (pattern.port !== undefined && pattern.port !== url.port) {
    return false;
  }
  if (!globToRegex(pattern.hostname, ".").test(url.hostname)) {
    return false;
  }
  if (pattern.search !== undefined && pattern.search !== url.search) {
    return false;
  }
  if (!globToRegex(pattern.pathname ?? "**", "/").test(url.pathname)) {
    return false;
  }
  return true;
}

export function hasRemoteMatch(
  domains: string[],
  remotePatterns: Array<URL | RemotePattern>,
  url: URL,
): boolean {
  return (
    domains.some((domain) => domain === url.hostname) ||
    remotePatterns.some((pattern) => matchRemotePattern(pattern, url))
  );
}

export function matchLocalPattern(pattern: LocalPattern, url: URL): boolean {
  if (pattern.search !== undefined && pattern.search !== url.search) {
    return false;
  }
  if (!globToRegex(pattern.pathname ?? "**", "/").test(url.pathname)) {
    return false;
  }
  return true;
}

export function hasLocalMatch(
  localPatterns: LocalPattern[] | undefined,
  urlPathAndQuery: string,
): boolean {
  if (!localPatterns) {
    return true;
  }
  const url = new URL(urlPathAndQuery, "http://n");
  return localPatterns.some((pattern) => matchLocalPattern(pattern, url));
}
