/**
 * next/image shim
 *
 * Translates Next.js Image props to @unpic/react Image component.
 * @unpic/react auto-detects CDN from URL and uses native transforms.
 * For local images (relative paths), routes through `/_vinext/image`
 * for server-side optimization (resize, format negotiation, quality).
 *
 * Remote images are validated against `images.remotePatterns` and
 * `images.domains` from next.config.js. Unmatched URLs are blocked
 * in production and warn in development, matching Next.js behavior.
 */
import React, { forwardRef } from "react";
import { Image as UnpicImage } from "@unpic/react";
import { hasRemoteMatch, type RemotePattern } from "./image-config.js";

// ─── Type exports (Next.js 16 compat) ────────────────────────────────────

export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
}

export interface StaticRequire {
  default: StaticImageData;
}

export type StaticImport = StaticRequire | StaticImageData;

export interface ImageLoaderProps {
  src: string;
  width: number;
  quality?: number;
}

export type ImageLoader = (props: ImageLoaderProps) => string;

export type PlaceholderValue = "blur" | "empty" | `data:image/${string}`;

// ─── Build-time config ───────────────────────────────────────────────────

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
const __isDev = process.env.NODE_ENV !== "production";
const __imageDeviceSizes: number[] = (() => {
  try {
    return JSON.parse(
      process.env.__VINEXT_IMAGE_DEVICE_SIZES ?? "[640,750,828,1080,1200,1920,2048,3840]",
    );
  } catch {
    return [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
  }
})();
/**
 * Allowed quality values from next.config.js `images.qualities`.
 * When set, quality is rounded to the nearest allowed value.
 */
const __imageQualities: number[] | undefined = (() => {
  try {
    const raw = process.env.__VINEXT_IMAGE_QUALITIES;
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
})();
/**
 * Whether dangerouslyAllowSVG is enabled in next.config.js.
 * When false (default), .svg sources auto-skip the optimization endpoint
 * and are served directly, matching Next.js behavior.
 * When true, .svg sources are routed through the optimizer (served as-is
 * with security headers).
 */
const __dangerouslyAllowSVG = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG === "true";

// ─── Helpers ─────────────────────────────────────────────────────────────

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
 */
function validateRemoteUrl(src: string): { allowed: boolean; reason?: string } {
  if (!__hasImageConfig) {
    // No image config — allow everything (backwards-compatible)
    return { allowed: true };
  }

  let url: URL;
  try {
    url = new URL(src, "http://n");
  } catch {
    return { allowed: false, reason: `Invalid URL: ${src}` };
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
 * Find the closest allowed quality value.
 * Matches Next.js 16 behavior: rounds to nearest value in the qualities array.
 */
export function findClosestQuality(quality: number, qualities?: number[]): number {
  if (!qualities?.length) return quality;
  return qualities.reduce(
    (prev, cur) => (Math.abs(cur - quality) < Math.abs(prev - quality) ? cur : prev),
    qualities[0],
  );
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
function sanitizeBlurDataURL(url: string): string | undefined {
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
function isRemoteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
}

/**
 * Responsive image widths matching Next.js's device sizes config.
 * These are the breakpoints used for srcSet generation.
 * Configurable via `images.deviceSizes` in next.config.js.
 */
const RESPONSIVE_WIDTHS = __imageDeviceSizes;

/**
 * Parse a string number to a number. Next.js 16 accepts `width` and `height`
 * as `number | \`${number}\``.
 */
function toNumber(value: number | `${number}` | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  return parseInt(value, 10);
}

/**
 * Unwrap a StaticImport to get the StaticImageData.
 * Handles both `{ default: StaticImageData }` and `StaticImageData` directly.
 */
function unwrapStaticImport(src: string | StaticImport): string | StaticImageData {
  if (typeof src === "string") return src;
  if ("default" in src) return src.default;
  return src;
}

// ─── ImageProps ───────────────────────────────────────────────────────────

export interface ImageProps {
  src: string | StaticImport;
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  priority?: boolean;
  preload?: boolean;
  quality?: number;
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  loader?: ImageLoader;
  sizes?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  id?: string;
  // Accept and ignore Next.js-specific props that don't apply
  unoptimized?: boolean;
  overrideSrc?: string;
  loading?: "lazy" | "eager";
  /** @deprecated Use onLoad instead */
  onLoadingComplete?: (img: HTMLImageElement) => void;
  /** @deprecated Use fill instead */
  layout?: string;
  /** @deprecated Use style instead */
  objectFit?: string;
  /** @deprecated Use style instead */
  objectPosition?: string;
  /** @deprecated This prop does not do anything */
  lazyBoundary?: string;
  /** @deprecated This prop does not do anything */
  lazyRoot?: string;
}

// ─── URL building ────────────────────────────────────────────────────────

/**
 * Build a `/_vinext/image` optimization URL.
 *
 * In production (Cloudflare Workers), the worker intercepts this path and uses
 * the Images binding to resize/transcode on the fly. In dev, the Vite dev
 * server handles it as a passthrough (serves the original file).
 */
export function imageOptimizationUrl(src: string, width: number, quality: number = 75): string {
  const q = findClosestQuality(quality, __imageQualities);
  return `/_vinext/image?url=${encodeURIComponent(src)}&w=${width}&q=${q}`;
}

/**
 * Generate a srcSet string for responsive images.
 *
 * Each width points to the `/_vinext/image` optimization endpoint so the
 * server can resize and transcode the image. Only includes widths that are
 * <= 2x the original image width to avoid pointless upscaling.
 */
function generateSrcSet(src: string, originalWidth: number, quality: number = 75): string {
  const widths = RESPONSIVE_WIDTHS.filter((w) => w <= originalWidth * 2);
  if (widths.length === 0)
    return `${imageOptimizationUrl(src, originalWidth, quality)} ${originalWidth}w`;
  return widths.map((w) => `${imageOptimizationUrl(src, w, quality)} ${w}w`).join(", ");
}

// ─── Image component ─────────────────────────────────────────────────────

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src: srcProp,
    alt,
    width: widthProp,
    height: heightProp,
    fill,
    priority,
    preload,
    quality,
    placeholder,
    blurDataURL,
    loader,
    sizes,
    className,
    style,
    unoptimized: _unoptimized,
    overrideSrc: _overrideSrc,
    loading,
    // Destructure deprecated props so they don't leak into ...rest
    onLoadingComplete: _onLoadingComplete,
    layout: _layout,
    objectFit: _objectFit,
    objectPosition: _objectPosition,
    lazyBoundary: _lazyBoundary,
    lazyRoot: _lazyRoot,
    ...rest
  },
  ref,
) {
  // Handle StaticImageData / StaticImport (import result)
  const unwrapped = unwrapStaticImport(srcProp);
  const src = typeof unwrapped === "string" ? unwrapped : unwrapped.src;
  const width = toNumber(widthProp);
  const height = toNumber(heightProp);
  const imgWidth = width ?? (typeof unwrapped === "object" ? unwrapped.width : undefined);
  const imgHeight = height ?? (typeof unwrapped === "object" ? unwrapped.height : undefined);
  const imgBlurDataURL =
    blurDataURL ?? (typeof unwrapped === "object" ? unwrapped.blurDataURL : undefined);

  // Both priority and preload trigger eager loading (Next.js 16 compat)
  const isEager = priority || preload;

  // If a custom loader is provided, use basic img with loader URL
  if (loader) {
    const resolvedSrc = loader({ src, width: imgWidth ?? 0, quality: quality ?? 75 });
    return (
      <img
        ref={ref}
        src={resolvedSrc}
        alt={alt}
        width={fill ? undefined : imgWidth}
        height={fill ? undefined : imgHeight}
        loading={isEager ? "eager" : (loading ?? "lazy")}
        decoding="async"
        sizes={sizes}
        className={className}
        style={
          fill
            ? {
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
                ...style,
              }
            : style
        }
        {...rest}
      />
    );
  }

  // For remote URLs, validate against remotePatterns then use @unpic/react
  if (isRemoteUrl(src)) {
    const validation = validateRemoteUrl(src);
    if (!validation.allowed) {
      if (__isDev) {
        console.warn(`[next/image] ${validation.reason}`);
        // In dev, render the image but with a warning — matches Next.js dev behavior
      } else {
        // In production, block the image entirely
        console.error(`[next/image] ${validation.reason}`);
        return null;
      }
    }

    const isDataPlaceholder =
      typeof placeholder === "string" && placeholder.startsWith("data:image/");
    const effectiveBlurDataURL = isDataPlaceholder ? placeholder : imgBlurDataURL;
    const sanitizedBlur = effectiveBlurDataURL
      ? sanitizeBlurDataURL(effectiveBlurDataURL)
      : undefined;
    const bg =
      (placeholder === "blur" || isDataPlaceholder) && sanitizedBlur
        ? `url(${sanitizedBlur})`
        : undefined;

    if (fill) {
      return (
        <UnpicImage
          src={src}
          alt={alt}
          layout="fullWidth"
          priority={isEager}
          sizes={sizes}
          className={className}
          background={bg}
        />
      );
    }
    // constrained layout requires width+height or aspectRatio
    if (imgWidth && imgHeight) {
      return (
        <UnpicImage
          src={src}
          alt={alt}
          width={imgWidth}
          height={imgHeight}
          layout="constrained"
          priority={isEager}
          sizes={sizes}
          className={className}
          background={bg}
        />
      );
    }
    // Fall through to basic <img> if dimensions not provided
    // (unpic requires them for constrained layout)
  }

  // Route local images through the /_vinext/image optimization endpoint.
  // In production on Cloudflare Workers, this resizes and transcodes via
  // the Images binding. In dev, it serves the original file as a passthrough.
  // When `unoptimized` is true, bypass the endpoint entirely (Next.js compat).
  // SVG sources auto-skip unless dangerouslyAllowSVG is enabled, matching
  // Next.js behavior where .svg triggers unoptimized=true by default.
  const imgQuality = quality ?? 75;
  const isSvg = src.endsWith(".svg");
  const skipOptimization = _unoptimized === true || (isSvg && !__dangerouslyAllowSVG);

  // Handle data: URL placeholder used directly as placeholder value
  const isDataPlaceholder =
    typeof placeholder === "string" && placeholder.startsWith("data:image/");
  const effectiveBlurDataURL = isDataPlaceholder ? placeholder : imgBlurDataURL;

  // Build srcSet for responsive local images (common breakpoints).
  // Each entry points to /_vinext/image with the appropriate width.
  const srcSet =
    imgWidth && !fill && !skipOptimization
      ? generateSrcSet(src, imgWidth, imgQuality)
      : imgWidth && !fill
        ? RESPONSIVE_WIDTHS.filter((w) => w <= imgWidth * 2)
            .map((w) => `${src} ${w}w`)
            .join(", ") || `${src} ${imgWidth}w`
        : undefined;

  // The main `src` also goes through the optimization endpoint. Use the
  // declared width (or the first responsive width as fallback).
  const optimizedSrc = skipOptimization
    ? src
    : imgWidth
      ? imageOptimizationUrl(src, imgWidth, imgQuality)
      : imageOptimizationUrl(src, RESPONSIVE_WIDTHS[0], imgQuality);

  // Blur placeholder: show a low-quality background while the image loads.
  // Sanitize blurDataURL to prevent CSS injection via crafted data URLs.
  const sanitizedLocalBlur = effectiveBlurDataURL
    ? sanitizeBlurDataURL(effectiveBlurDataURL)
    : undefined;
  const showBlur = (placeholder === "blur" || isDataPlaceholder) && sanitizedLocalBlur;
  const blurStyle = showBlur
    ? {
        backgroundImage: `url(${sanitizedLocalBlur})`,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
      }
    : undefined;

  // For local images, render a standard <img> tag with srcSet and blur support.
  // The src and srcSet point to the /_vinext/image optimization endpoint.
  return (
    <img
      ref={ref}
      src={optimizedSrc}
      alt={alt}
      width={fill ? undefined : imgWidth}
      height={fill ? undefined : imgHeight}
      loading={isEager ? "eager" : (loading ?? "lazy")}
      fetchPriority={isEager ? "high" : undefined}
      decoding="async"
      srcSet={srcSet}
      sizes={sizes ?? (fill ? "100vw" : undefined)}
      className={className}
      data-nimg={fill ? "fill" : "1"}
      style={
        fill
          ? {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              ...blurStyle,
              ...style,
            }
          : { ...blurStyle, ...style }
      }
      {...rest}
    />
  );
});

// ─── getImageProps ────────────────────────────────────────────────────────

/**
 * getImageProps — for advanced use cases (picture elements, background images).
 * Returns the props that would be passed to the underlying <img> element.
 */
export function getImageProps(props: ImageProps): {
  props: React.ImgHTMLAttributes<HTMLImageElement>;
} {
  const {
    src: srcProp,
    alt,
    width: widthProp,
    height: heightProp,
    fill,
    priority,
    preload,
    quality: _quality,
    placeholder,
    blurDataURL: blurDataURLProp,
    loader,
    sizes,
    className,
    style,
    unoptimized: _unoptimized,
    overrideSrc: _overrideSrc,
    loading,
    // Destructure deprecated props so they don't leak into ...rest
    onLoadingComplete: _onLoadingComplete,
    layout: _layout,
    objectFit: _objectFit,
    objectPosition: _objectPosition,
    lazyBoundary: _lazyBoundary,
    lazyRoot: _lazyRoot,
    ...rest
  } = props;

  const unwrapped = unwrapStaticImport(srcProp);
  const src = typeof unwrapped === "string" ? unwrapped : unwrapped.src;
  const width = toNumber(widthProp);
  const height = toNumber(heightProp);
  const imgWidth = width ?? (typeof unwrapped === "object" ? unwrapped.width : undefined);
  const imgHeight = height ?? (typeof unwrapped === "object" ? unwrapped.height : undefined);
  const imgBlurDataURL =
    blurDataURLProp ?? (typeof unwrapped === "object" ? unwrapped.blurDataURL : undefined);

  // Both priority and preload trigger eager loading (Next.js 16 compat)
  const isEager = priority || preload;

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
  const imgQuality = _quality ?? 75;
  const resolvedSrc = blockedInProd
    ? ""
    : loader
      ? loader({ src, width: imgWidth ?? 0, quality: imgQuality })
      : src;

  // For local images (no loader, not remote), route through optimization endpoint.
  // When `unoptimized` is true, bypass the endpoint entirely (Next.js compat).
  // SVG sources auto-skip unless dangerouslyAllowSVG is enabled.
  const isSvg = resolvedSrc.endsWith(".svg");
  const skipOpt =
    _unoptimized === true ||
    (isSvg && !__dangerouslyAllowSVG) ||
    blockedInProd ||
    !!loader ||
    isRemoteUrl(resolvedSrc);
  const optimizedSrc = skipOpt
    ? resolvedSrc
    : imgWidth
      ? imageOptimizationUrl(resolvedSrc, imgWidth, imgQuality)
      : imageOptimizationUrl(resolvedSrc, RESPONSIVE_WIDTHS[0], imgQuality);

  // Build srcSet for local images — each width points to /_vinext/image
  const srcSet =
    imgWidth && !fill && !isRemoteUrl(resolvedSrc) && !loader && !skipOpt
      ? generateSrcSet(resolvedSrc, imgWidth, imgQuality)
      : undefined;

  // Handle data: URL placeholder used directly as placeholder value
  const isDataPlaceholder =
    typeof placeholder === "string" && placeholder.startsWith("data:image/");
  const effectiveBlurDataURL = isDataPlaceholder ? placeholder : imgBlurDataURL;

  // Blur placeholder styles — sanitize to prevent CSS injection
  const sanitizedBlurURL = effectiveBlurDataURL
    ? sanitizeBlurDataURL(effectiveBlurDataURL)
    : undefined;
  const showBlur = (placeholder === "blur" || isDataPlaceholder) && sanitizedBlurURL;
  const blurStyle = showBlur
    ? {
        backgroundImage: `url(${sanitizedBlurURL})`,
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat" as const,
        backgroundPosition: "center" as const,
      }
    : undefined;

  return {
    props: {
      src: optimizedSrc,
      alt,
      width: fill ? undefined : imgWidth,
      height: fill ? undefined : imgHeight,
      loading: isEager ? "eager" : (loading ?? "lazy"),
      fetchPriority: isEager ? ("high" as const) : undefined,
      decoding: "async" as const,
      srcSet,
      sizes: sizes ?? (fill ? "100vw" : undefined),
      className,
      "data-nimg": fill ? "fill" : "1",
      style: fill
        ? {
            position: "absolute" as const,
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover" as const,
            ...blurStyle,
            ...style,
          }
        : { ...blurStyle, ...style },
      ...rest,
    } as React.ImgHTMLAttributes<HTMLImageElement>,
  };
}

export default Image;
