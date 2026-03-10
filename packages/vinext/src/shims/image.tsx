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

export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
  blurWidth?: number;
  blurHeight?: number;
}

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
const __imageImageSizes: number[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_IMAGE_SIZES ?? "[16,32,48,64,96,128,256,384]");
  } catch {
    return [16, 32, 48, 64, 96, 128, 256, 384];
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
 * Placeholder value type matching Next.js 16.x.
 * Accepts 'blur', 'empty', or a data:image/* URL for custom placeholders.
 */
export type PlaceholderValue = "blur" | "empty" | `data:image/${string}`;

export interface ImageProps {
  src: string | StaticImageData;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  loader?: (params: { src: string; width: number; quality?: number }) => string;
  sizes?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  id?: string;
  unoptimized?: boolean;
  overrideSrc?: string;
  loading?: "lazy" | "eager";
  // Deprecated props — accepted but ignored for backwards compatibility
  /** @deprecated Use `fill` instead */
  layout?: string;
  /** @deprecated Use `style={{ objectFit: ... }}` instead */
  objectFit?: string;
  /** @deprecated Use `style={{ objectPosition: ... }}` instead */
  objectPosition?: string;
  /** @deprecated No longer needed */
  lazyBoundary?: string;
  /** @deprecated No longer needed */
  lazyRoot?: unknown;
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
 * All allowed widths for srcSet generation, combining imageSizes and deviceSizes.
 * Sorted ascending. Matches Next.js behavior where the full set of allowed
 * widths is [...imageSizes, ...deviceSizes].sort().
 */
const ALL_SIZES = [...__imageImageSizes, ...__imageDeviceSizes].sort((a, b) => a - b);
/**
 * Responsive image widths matching Next.js's device sizes config.
 * These are the breakpoints used for srcSet generation.
 * Configurable via `images.deviceSizes` in next.config.js.
 */
const RESPONSIVE_WIDTHS = __imageDeviceSizes;

/**
 * Build a `/_vinext/image` optimization URL.
 *
 * In production (Cloudflare Workers), the worker intercepts this path and uses
 * the Images binding to resize/transcode on the fly. In dev, the Vite dev
 * server handles it as a passthrough (serves the original file).
 */
export function imageOptimizationUrl(src: string, width: number, quality: number = 75): string {
  return `/_vinext/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
}

/**
 * Determine the widths and descriptor kind for srcSet generation.
 * Matches Next.js getWidths() in packages/next/src/shared/lib/get-img-props.ts.
 *
 * - When `sizes` is provided: uses allSizes (filtered by vw% if present), kind='w'
 * - When `sizes` is absent + width is given: snaps [width, width*2] to nearest
 *   allSizes values, kind='x' (1x, 2x descriptors)
 * - When neither: uses deviceSizes, kind='w'
 */
function getWidths(
  width: number | undefined,
  sizes: string | undefined,
): { widths: number[]; kind: "w" | "x" } {
  if (sizes) {
    // Find all "vw" percent sizes used in the sizes prop
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g;
    const percentSizes: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = viewportWidthRe.exec(sizes)) !== null) {
      percentSizes.push(parseInt(match[2]));
    }
    if (percentSizes.length) {
      const smallestRatio = Math.min(...percentSizes) * 0.01;
      return {
        widths: ALL_SIZES.filter((s) => s >= RESPONSIVE_WIDTHS[0] * smallestRatio),
        kind: "w",
      };
    }
    return { widths: ALL_SIZES, kind: "w" };
  }
  if (typeof width !== "number") {
    return { widths: RESPONSIVE_WIDTHS, kind: "w" };
  }
  // No sizes prop, width is known: x-descriptor mode
  // Snap [width, width*2] to nearest allSizes value >= target
  const widths = [
    ...new Set(
      [width, width * 2].map(
        (w) => ALL_SIZES.find((p) => p >= w) || ALL_SIZES[ALL_SIZES.length - 1],
      ),
    ),
  ];
  return { widths, kind: "x" };
}

/**
 * Generate srcSet, sizes, and src attributes for an image.
 * Matches Next.js genImgAttrs() behavior.
 */
function generateImgAttrs(
  src: string,
  width: number | undefined,
  sizes: string | undefined,
  quality: number = 75,
): { src: string; srcSet: string | undefined; sizes: string | undefined } {
  const { widths, kind } = getWidths(width, sizes);
  const last = widths.length - 1;

  return {
    sizes: !sizes && kind === "w" ? "100vw" : sizes,
    srcSet: widths
      .map((w, i) => `${imageOptimizationUrl(src, w, quality)} ${kind === "w" ? w : i + 1}${kind}`)
      .join(", "),
    src: imageOptimizationUrl(src, widths[last], quality),
  };
}

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src: srcProp,
    alt,
    width,
    height,
    fill,
    priority,
    quality,
    placeholder,
    blurDataURL,
    loader,
    sizes,
    className,
    style,
    unoptimized: _unoptimized,
    overrideSrc,
    loading,
    // Deprecated props — destructure to prevent leaking to <img> via ...rest
    layout: _layout,
    objectFit: _objectFit,
    objectPosition: _objectPosition,
    lazyBoundary: _lazyBoundary,
    lazyRoot: _lazyRoot,
    ...rest
  },
  ref,
) {
  // Handle StaticImageData (import result)
  const src = typeof srcProp === "string" ? srcProp : srcProp.src;
  const imgWidth = width ?? (typeof srcProp === "object" ? srcProp.width : undefined);
  const imgHeight = height ?? (typeof srcProp === "object" ? srcProp.height : undefined);
  const imgBlurDataURL =
    blurDataURL ?? (typeof srcProp === "object" ? srcProp.blurDataURL : undefined);

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
        loading={priority ? "eager" : (loading ?? "lazy")}
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

    const sanitizedBlur = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
    const bg = placeholder === "blur" && sanitizedBlur ? `url(${sanitizedBlur})` : undefined;

    if (fill) {
      return (
        <UnpicImage
          src={src}
          alt={alt}
          layout="fullWidth"
          priority={priority}
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
          priority={priority}
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

  // Generate srcSet/src/sizes using Next.js-compatible getWidths logic.
  // When no sizes prop and width is known → x-descriptors (1x, 2x).
  // When sizes is provided → w-descriptors with allSizes.
  const imgAttrs =
    !fill && !skipOptimization ? generateImgAttrs(src, imgWidth, sizes, imgQuality) : undefined;

  const srcSet = imgAttrs?.srcSet;

  const optimizedSrc = skipOptimization
    ? src
    : imgAttrs
      ? imgAttrs.src
      : imageOptimizationUrl(src, RESPONSIVE_WIDTHS[0], imgQuality);

  // Placeholder: show a background while the image loads.
  // 'blur' uses blurDataURL, data:image/* strings are used directly.
  // Sanitize all data URLs to prevent CSS injection.
  const sanitizedLocalBlur = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
  const placeholderUrl =
    placeholder === "blur"
      ? sanitizedLocalBlur
      : typeof placeholder === "string" && placeholder.startsWith("data:image/")
        ? sanitizeBlurDataURL(placeholder)
        : undefined;
  const blurStyle = placeholderUrl
    ? {
        backgroundImage: `url(${placeholderUrl})`,
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
      src={overrideSrc || optimizedSrc}
      alt={alt}
      width={fill ? undefined : imgWidth}
      height={fill ? undefined : imgHeight}
      loading={priority ? "eager" : (loading ?? "lazy")}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
      srcSet={srcSet}
      sizes={imgAttrs?.sizes ?? (fill ? "100vw" : undefined)}
      className={className}
      data-nimg={fill ? "fill" : "1"}
      style={
        fill
          ? {
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              ...blurStyle,
              ...style,
            }
          : { ...blurStyle, ...style }
      }
      {...rest}
    />
  );
});

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
    width,
    height,
    fill,
    priority,
    quality: _quality,
    placeholder,
    blurDataURL: blurDataURLProp,
    loader,
    sizes,
    className,
    style,
    unoptimized: _unoptimized,
    overrideSrc,
    loading,
    // Deprecated props — destructure to prevent leaking to output
    layout: _layout,
    objectFit: _objectFit,
    objectPosition: _objectPosition,
    lazyBoundary: _lazyBoundary,
    lazyRoot: _lazyRoot,
    ...rest
  } = props;

  const src = typeof srcProp === "string" ? srcProp : srcProp.src;
  const imgWidth = width ?? (typeof srcProp === "object" ? srcProp.width : undefined);
  const imgHeight = height ?? (typeof srcProp === "object" ? srcProp.height : undefined);
  const imgBlurDataURL =
    blurDataURLProp ?? (typeof srcProp === "object" ? srcProp.blurDataURL : undefined);

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

  // Generate srcSet/src/sizes using Next.js-compatible getWidths logic
  const imgAttrs =
    !fill && !skipOpt ? generateImgAttrs(resolvedSrc, imgWidth, sizes, imgQuality) : undefined;

  const optimizedSrc = skipOpt
    ? resolvedSrc
    : imgAttrs
      ? imgAttrs.src
      : imageOptimizationUrl(resolvedSrc, RESPONSIVE_WIDTHS[0], imgQuality);

  const srcSet = imgAttrs?.srcSet;

  // Placeholder styles — sanitize to prevent CSS injection
  const sanitizedBlurURL = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
  const placeholderUrl =
    placeholder === "blur"
      ? sanitizedBlurURL
      : typeof placeholder === "string" && placeholder.startsWith("data:image/")
        ? sanitizeBlurDataURL(placeholder)
        : undefined;
  const blurStyle = placeholderUrl
    ? {
        backgroundImage: `url(${placeholderUrl})`,
        backgroundSize: "cover" as const,
        backgroundRepeat: "no-repeat" as const,
        backgroundPosition: "center" as const,
      }
    : undefined;

  return {
    props: {
      src: overrideSrc || optimizedSrc,
      alt,
      width: fill ? undefined : imgWidth,
      height: fill ? undefined : imgHeight,
      loading: priority ? "eager" : (loading ?? "lazy"),
      fetchPriority: priority ? ("high" as const) : undefined,
      decoding: "async" as const,
      srcSet,
      sizes: imgAttrs?.sizes ?? (fill ? "100vw" : undefined),
      className,
      "data-nimg": fill ? "fill" : "1",
      style: fill
        ? {
            position: "absolute" as const,
            inset: 0,
            width: "100%",
            height: "100%",
            ...blurStyle,
            ...style,
          }
        : { ...blurStyle, ...style },
      ...rest,
    } as React.ImgHTMLAttributes<HTMLImageElement>,
  };
}

export default Image;
