/**
 * Server-safe next/image helpers.
 *
 * Holds the image config, URL builders, and `getImageProps`. This module has
 * no "use client" directive so `getImageProps` can run in Server Components,
 * matching Next.js where `next/image` (shared/lib/image-external.tsx) is
 * server-safe and only the Image component is a client reference.
 *
 * Remote images are validated against `images.remotePatterns` and
 * `images.domains` from next.config.js. Unmatched URLs are blocked
 * in production and warn in development, matching Next.js behavior.
 */
import type React from "react";
import type {
  ImageProps,
  ImgProps,
  StaticImport,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
import { getDeploymentId } from "../utils/deployment-id.js";
import { hasRemoteMatch, isPrivateIp, type RemotePattern } from "./image-config.js";

/**
 * Image config injected at build time via Vite define.
 * Serialized as JSON — parsed once at module level.
 */
const __imageRemotePatterns: RemotePattern[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_REMOTE_PATTERNS ?? "[]");
  } catch {
    return [];
  }
})();
const __imageDomains: string[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_DOMAINS ?? "[]");
  } catch {
    return [];
  }
})();
const __hasImageConfig = __imageRemotePatterns.length > 0 || __imageDomains.length > 0;
export const __isDev = process.env.NODE_ENV !== "production";
const __imageDeviceSizes: number[] = (() => {
  try {
    return JSON.parse(
      process.env.__VINEXT_IMAGE_DEVICE_SIZES ?? "[640,750,828,1080,1200,1920,2048,3840]",
    );
  } catch {
    return [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  }
})();
const __imageSizes: number[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_SIZES ?? "[32,48,64,96,128,256,384]");
  } catch {
    return [32, 48, 64, 96, 128, 256, 384];
  }
})();
/**
 * Whether dangerouslyAllowSVG is enabled in next.config.js.
 * When false (default), .svg sources auto-skip the optimization endpoint
 * and are served directly, matching Next.js behavior.
 * When true, .svg sources are routed through the optimizer (served as-is
 * with security headers).
 */
export const __dangerouslyAllowSVG = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG === "true";
/**
 * Whether dangerouslyAllowLocalIP is enabled in next.config.js.
 * When false (default), remote image URLs with literal private-IP hostnames
 * are blocked to mitigate SSRF risk.
 */
const __dangerouslyAllowLocalIP = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP === "true";
export const __globallyUnoptimized = process.env.__VINEXT_IMAGE_UNOPTIMIZED === "true";

/**
 * Validate that a remote URL is allowed by the configured remote patterns.
 * Returns true if the URL is allowed, false otherwise.
 *
 * When no remotePatterns/domains are configured, all remote URLs are allowed
 * (backwards-compatible — user hasn't opted into restriction).
 *
 * When patterns ARE configured, only matching URLs are allowed.
 * In development, non-matching URLs produce a console warning.
 * In production, non-matching URLs are blocked (src replaced with empty string).
 *
 * Private-IP hostnames are additionally rejected unless dangerouslyAllowLocalIP
 * is set, mirroring Next.js's fetchExternalImage guard.
 */
export function validateRemoteUrl(src: string): { allowed: boolean; reason?: string } {
  let url: URL;
  try {
    url = new URL(src, "http://n");
  } catch {
    return { allowed: false, reason: `Invalid URL: ${src}` };
  }

  if (!__dangerouslyAllowLocalIP && isPrivateIp(url.hostname)) {
    // Best-effort guard for literal-IP hostnames only. Domain names resolving
    // to private IPs cannot be caught without server-side DNS resolution.
    // See: Next.js fetchExternalImage in packages/next/src/server/image-optimizer.ts
    return {
      allowed: false,
      reason: `Image URL "${src}" resolved to private IP. If this is expected and you understand SSRF risk, use images.dangerouslyAllowLocalIP = true to continue.`,
    };
  }

  if (!__hasImageConfig) {
    // No image config — allow everything (backwards-compatible)
    return { allowed: true };
  }

  if (hasRemoteMatch(__imageDomains, __imageRemotePatterns, url)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Image URL "${src}" is not configured in images.remotePatterns or images.domains in next.config.js. See: https://nextjs.org/docs/messages/next-image-unconfigured-host`,
  };
}

/**
 * Sanitize a blurDataURL to prevent CSS injection.
 *
 * A crafted data URL containing `)` can break out of the `url()` CSS function,
 * allowing injection of arbitrary CSS properties or rules. Characters like `{`,
 * `}`, and `\` can also assist in crafting injection payloads.
 *
 * This validates the URL starts with `data:image/` and rejects characters that
 * could escape the `url()` context. Semicolons are allowed since they're part
 * of valid data URLs (`data:image/png;base64,...`) and harmless inside `url()`.
 *
 * Returns undefined for invalid URLs, which causes the blur placeholder to be
 * skipped gracefully.
 */
export function sanitizeBlurDataURL(url: string): string | undefined {
  // Must be a data: image URL
  if (!url.startsWith("data:image/")) return undefined;
  // Reject characters that can break out of CSS url():
  //   ) - closes url()
  //   ( - could open nested functions
  //   { } - CSS rule boundaries
  //   \ - CSS escape sequences
  //   newlines - break CSS parsing
  if (/[)(}{\\'"\n\r]/.test(url)) return undefined;
  return url;
}

/**
 * Determine if a src is a remote URL (CDN-optimizable) or local.
 */
export function isRemoteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
}

export function isSvgUrl(src: string): boolean {
  try {
    return new URL(src, "http://vinext.local").pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

export function getFillStyle(
  style?: React.CSSProperties,
  backgroundStyle?: React.CSSProperties,
): React.CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
    ...backgroundStyle,
    ...style,
  };
}

/**
 * Resolve src, width, height, blurDataURL from Image props (string or StaticImageData).
 * Shared by the Image component and getImageProps to keep behavior in sync.
 */
export function resolveImageSource(v: {
  src: string | StaticImport;
  width?: number | `${number}`;
  height?: number | `${number}`;
  blurDataURL?: string;
}): { src: string; width?: number; height?: number; blurDataURL?: string } {
  const staticData = typeof v.src === "object" && "default" in v.src ? v.src.default : v.src;
  const src = typeof staticData === "string" ? staticData : staticData.src;
  const sourceWidth = v.width ?? (typeof staticData === "object" ? staticData.width : undefined);
  const sourceHeight = v.height ?? (typeof staticData === "object" ? staticData.height : undefined);
  const imgWidth = typeof sourceWidth === "string" ? Number(sourceWidth) : sourceWidth;
  const imgHeight = typeof sourceHeight === "string" ? Number(sourceHeight) : sourceHeight;
  const imgBlurDataURL =
    v.blurDataURL ?? (typeof staticData === "object" ? staticData.blurDataURL : undefined);
  return { src, width: imgWidth, height: imgHeight, blurDataURL: imgBlurDataURL };
}

/**
 * Responsive image widths matching Next.js's device sizes config.
 * These are the breakpoints used for srcSet generation.
 * Configurable via `images.deviceSizes` in next.config.js.
 */
export const RESPONSIVE_WIDTHS = [...__imageDeviceSizes].sort((left, right) => left - right);
const ALL_IMAGE_WIDTHS = [...RESPONSIVE_WIDTHS, ...__imageSizes].sort(
  (left, right) => left - right,
);

function extractLocalDeploymentId(src: string): { src: string; deploymentId?: string } {
  let deploymentId = getDeploymentId();
  if (!src.startsWith("/") || src.startsWith("//")) return { src, deploymentId };

  const queryIndex = src.indexOf("?");
  if (queryIndex === -1) return { src, deploymentId };

  const params = new URLSearchParams(src.slice(queryIndex + 1));
  const sourceDeploymentId = params.get("dpl");
  if (!sourceDeploymentId) return { src, deploymentId };

  deploymentId = sourceDeploymentId;
  params.delete("dpl");
  const remainingQuery = params.toString();
  return {
    src: src.slice(0, queryIndex) + (remainingQuery ? `?${remainingQuery}` : ""),
    deploymentId,
  };
}

// Next.js defaults `images.path` to `${basePath}/_next/image` and appends a
// slash when trailingSlash is enabled. The `url` source is never prefixed.
const __imageEndpoint = `${process.env.__NEXT_ROUTER_BASEPATH ?? ""}/_next/image${
  process.env.__VINEXT_TRAILING_SLASH === "true" ? "/" : ""
}`;

/**
 * Build a `/_next/image` optimization URL.
 *
 * In production (Cloudflare Workers), the worker intercepts this path and uses
 * the Images binding to resize/transcode on the fly. In dev, the Vite dev
 * server handles it as a passthrough (serves the original file).
 */
export function imageOptimizationUrl(src: string, width: number, quality: number = 75): string {
  const source = extractLocalDeploymentId(src);
  const deploymentQuery =
    source.src.startsWith("/") && source.deploymentId ? `&dpl=${source.deploymentId}` : "";
  return `${__imageEndpoint}?url=${encodeURIComponent(source.src)}&w=${width}&q=${quality}${deploymentQuery}`;
}

/**
 * Generate a srcSet string for responsive images.
 *
 * Each width points to the `/_next/image` optimization endpoint so the
 * server can resize and transcode the image.
 */
function getImageWidths(width: number): number[] {
  return [
    ...new Set(
      [width, width * 2].map(
        (targetWidth) =>
          ALL_IMAGE_WIDTHS.find((configuredWidth) => configuredWidth >= targetWidth) ??
          ALL_IMAGE_WIDTHS[ALL_IMAGE_WIDTHS.length - 1],
      ),
    ),
  ];
}

export function generateImageAttributes(
  src: string,
  width: number,
  quality: number = 75,
  sizes?: string,
): { src: string; srcSet: string } {
  if (sizes) {
    const viewportWidthPattern = /(^|\s)(1?\d?\d)vw/g;
    const viewportPercentages = Array.from(sizes.matchAll(viewportWidthPattern), (match) =>
      Number.parseInt(match[2], 10),
    );
    const minimumWidth =
      viewportPercentages.length > 0
        ? RESPONSIVE_WIDTHS[0] * (Math.min(...viewportPercentages) * 0.01)
        : 0;
    const candidates = ALL_IMAGE_WIDTHS.filter((candidateWidth) => candidateWidth >= minimumWidth);
    return {
      src: imageOptimizationUrl(src, candidates[candidates.length - 1], quality),
      srcSet: candidates
        .map(
          (candidateWidth) =>
            `${imageOptimizationUrl(src, candidateWidth, quality)} ${candidateWidth}w`,
        )
        .join(", "),
    };
  }

  const widths = getImageWidths(width);
  return {
    src: imageOptimizationUrl(src, widths[widths.length - 1], quality),
    srcSet: widths
      .map(
        (candidateWidth, index) =>
          `${imageOptimizationUrl(src, candidateWidth, quality)} ${index + 1}x`,
      )
      .join(", "),
  };
}

/**
 * getImageProps — for advanced use cases (picture elements, background images).
 * Returns the props that would be passed to the underlying <img> element.
 */
export function getImageProps(props: ImageProps): { props: ImgProps } {
  const {
    src: srcProp,
    alt,
    width,
    height,
    fill,
    preload: _preload,
    priority,
    quality: _quality,
    placeholder,
    blurDataURL: blurDataURLProp,
    loader,
    sizes,
    className,
    style,
    onLoad: _onLoad,
    onLoadingComplete: _onLoadingComplete,
    unoptimized: _unoptimized,
    overrideSrc,
    loading,
    ...rest
  } = props;

  const {
    src,
    width: imgWidth,
    height: imgHeight,
    blurDataURL: imgBlurDataURL,
  } = resolveImageSource({ src: srcProp, width, height, blurDataURL: blurDataURLProp });
  const shouldPreload = _preload === true || priority === true;

  if (_unoptimized === true || __globallyUnoptimized) {
    // As in the component path, unoptimized images never reach the server-side
    // optimizer, so remote URL validation is intentionally unnecessary.
    const renderedSrc = overrideSrc || src;
    const sanitizedBlurURL = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
    const blurStyle =
      placeholder === "blur" && sanitizedBlurURL
        ? {
            backgroundImage: `url(${sanitizedBlurURL})`,
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat" as const,
            backgroundPosition: "center" as const,
          }
        : undefined;
    const imageProps: ImgProps = {
      src: renderedSrc,
      alt,
      width: fill ? undefined : imgWidth,
      height: fill ? undefined : imgHeight,
      loading: priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy"),
      fetchPriority: priority ? ("high" as const) : undefined,
      decoding: "async" as const,
      className,
      style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
      ...rest,
      sizes: sizes ?? (fill ? "100vw" : undefined),
      srcSet: undefined,
    };
    return { props: Object.assign(imageProps, { "data-nimg": fill ? "fill" : "1" }) };
  }

  // Validate remote URLs against configured patterns
  let blockedInProd = false;
  if (isRemoteUrl(src)) {
    const validation = validateRemoteUrl(src);
    if (!validation.allowed) {
      if (__isDev) {
        console.warn(`[next/image] ${validation.reason}`);
      } else {
        console.error(`[next/image] ${validation.reason}`);
        blockedInProd = true;
      }
    }
  }

  // Resolve src through custom loader if provided
  const imgQuality = typeof _quality === "string" ? Number(_quality) : (_quality ?? 75);
  const resolvedSrc = blockedInProd
    ? ""
    : loader
      ? loader({ src, width: imgWidth ?? 0, quality: imgQuality })
      : src;

  // For local images (no loader, not remote), route through optimization endpoint.
  // When `unoptimized` is true, bypass the endpoint entirely (Next.js compat).
  // SVG sources auto-skip unless dangerouslyAllowSVG is enabled.
  const isSvg = isSvgUrl(resolvedSrc);
  const skipOpt =
    (isSvg && !__dangerouslyAllowSVG) || blockedInProd || !!loader || isRemoteUrl(resolvedSrc);
  const optimizedAttributes =
    imgWidth && !fill && !skipOpt
      ? generateImageAttributes(resolvedSrc, imgWidth, imgQuality, sizes)
      : null;
  const optimizedSrc = skipOpt
    ? resolvedSrc
    : optimizedAttributes
      ? optimizedAttributes.src
      : imageOptimizationUrl(resolvedSrc, RESPONSIVE_WIDTHS[0], imgQuality);

  // Build srcSet for local images — each width points to /_next/image
  const srcSet = optimizedAttributes?.srcSet;

  // Blur placeholder styles — sanitize to prevent CSS injection
  const sanitizedBlurURL = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
  const blurStyle =
    placeholder === "blur" && sanitizedBlurURL
      ? {
          backgroundImage: `url(${sanitizedBlurURL})`,
          backgroundSize: "cover",
          backgroundRepeat: "no-repeat" as const,
          backgroundPosition: "center" as const,
        }
      : undefined;

  const imageProps: ImgProps = {
    src: optimizedSrc,
    alt,
    width: fill ? undefined : imgWidth,
    height: fill ? undefined : imgHeight,
    loading: priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy"),
    fetchPriority: priority ? ("high" as const) : undefined,
    decoding: "async" as const,
    srcSet,
    sizes: sizes ?? (fill ? "100vw" : undefined),
    className,
    style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
    ...rest,
  };
  return { props: Object.assign(imageProps, { "data-nimg": fill ? "fill" : "1" }) };
}
