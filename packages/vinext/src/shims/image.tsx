"use client";

/**
 * next/image shim
 *
 * Translates Next.js Image props to @unpic/react Image component.
 * @unpic/react auto-detects CDN from URL and uses native transforms.
 * For local images (relative paths), routes through `/_next/image`
 * for server-side optimization (resize, format negotiation, quality).
 *
 * Remote images are validated against `images.remotePatterns` and
 * `images.domains` from next.config.js. Unmatched URLs are blocked
 * in production and warn in development, matching Next.js behavior.
 */
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as ReactDOM from "react-dom";
import { Image as UnpicImage } from "@unpic/react";
import type {
  ImageLoader,
  ImageProps as UpstreamImageProps,
  ImgProps,
  StaticImageData,
  StaticImport,
  StaticRequire,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
import { getDeploymentId } from "../utils/deployment-id.js";
import { hasRemoteMatch, isPrivateIp, type RemotePattern } from "./image-config.js";
import { useMergedRef } from "./use-merged-ref.js";

export type { ImageLoader, StaticImageData, StaticRequire };
export type ImageLoaderProps = Parameters<ImageLoader>[0];
export type ImageProps = UpstreamImageProps;

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
const __imageSizes: number[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_SIZES ?? "[16,32,48,64,96,128,256,384]");
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
 * Whether dangerouslyAllowLocalIP is enabled in next.config.js.
 * When false (default), remote image URLs with literal private-IP hostnames
 * are blocked to mitigate SSRF risk.
 */
const __dangerouslyAllowLocalIP = process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_LOCAL_IP === "true";
const __globallyUnoptimized = process.env.__VINEXT_IMAGE_UNOPTIMIZED === "true";

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
function validateRemoteUrl(src: string): { allowed: boolean; reason?: string } {
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
 * A version of useLayoutEffect that doesn't warn during SSR.
 * Do not rename this to "isomorphic layout effect". There is no such thing as
 * an isomorphic Layout Effect since there is no Layout on the server.
 * Ported from Next.js: https://github.com/vercel/next.js/pull/93209
 */
const useNonWarningLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Create a synthetic React load event for replaying onLoad/onLoadingComplete
 * during hydration when the image already completed loading.
 *
 * This function creates a native Event("load") via the DOM Event constructor
 * and must only be called in a browser context (client-side layout effect).
 * It mirrors the pattern used in Next.js `handleLoading`.
 */
function createSyntheticLoadEvent(img: HTMLImageElement): React.SyntheticEvent<HTMLImageElement> {
  const nativeEvent = new Event("load");
  Object.defineProperty(nativeEvent, "target", { writable: false, value: img });
  let prevented = false;
  let stopped = false;
  return {
    bubbles: nativeEvent.bubbles,
    cancelable: nativeEvent.cancelable,
    currentTarget: img,
    defaultPrevented: false,
    eventPhase: nativeEvent.eventPhase,
    isTrusted: false,
    nativeEvent,
    target: img,
    timeStamp: nativeEvent.timeStamp,
    type: "load",
    isDefaultPrevented: () => prevented,
    isPropagationStopped: () => stopped,
    persist: () => {},
    preventDefault: () => {
      prevented = true;
      nativeEvent.preventDefault();
    },
    stopPropagation: () => {
      stopped = true;
      nativeEvent.stopPropagation();
    },
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

function isSvgUrl(src: string): boolean {
  try {
    return new URL(src, "http://vinext.local").pathname.toLowerCase().endsWith(".svg");
  } catch {
    return false;
  }
}

function getFillStyle(
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
function resolveImageSource(v: {
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
const RESPONSIVE_WIDTHS = [...__imageDeviceSizes].sort((left, right) => left - right);
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
  return `/_next/image?url=${encodeURIComponent(source.src)}&w=${width}&q=${quality}${deploymentQuery}`;
}

function preloadImageResource(input: {
  shouldPreload: boolean;
  src: string;
  srcSet?: string;
  sizes?: string;
  fetchPriority?: ReactDOM.PreloadOptions["fetchPriority"];
}): void {
  if (!input.shouldPreload) return;
  if (typeof ReactDOM.preload !== "function") return;
  ReactDOM.preload(input.src, {
    as: "image",
    imageSrcSet: input.srcSet,
    imageSizes: input.sizes,
    fetchPriority: input.fetchPriority,
  });
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

function generateImageAttributes(
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

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  {
    src: srcProp,
    alt,
    width,
    height,
    fill,
    preload,
    priority,
    quality,
    placeholder,
    blurDataURL,
    loader,
    sizes,
    className,
    style,
    onLoad,
    onLoadingComplete,
    onError,
    unoptimized: _unoptimized,
    overrideSrc,
    loading,
    ...rest
  },
  ref,
) {
  // Dedup refs: ensure onLoad and onError fire at most once per src per mount.
  // Matches Next.js behavior — prevents double-firing from React re-renders,
  // strict-mode double-invocation, or state updates inside the handler itself.
  // Ported from Next.js: https://github.com/vercel/next.js/pull/93209
  const lastLoadedSrcRef = useRef<string | undefined>(undefined);
  const lastErrorSrcRef = useRef<string | undefined>(undefined);

  // Hydration-level onError replay: when an image fails to load during SSR
  // streaming or initial HTML parse (before React hydrates), the native browser
  // error event is lost. Re-trigger it via `img.src = img.src` in a layout
  // effect once hydration completes, mirroring the upstream Next.js fix.
  // Ported from Next.js: https://github.com/vercel/next.js/pull/93209
  const didInsertRef = useRef(false);
  const imgElementRef = useRef<HTMLImageElement | null>(null);

  // Merge forwarded ref with internal img ref for layout effect access.
  const mergedRef = useMergedRef(ref, imgElementRef);

  // Stable refs for onLoad / onError / onLoadingComplete so the layout effect
  // does not re-run (and re-assign img.src) when handler identity changes.
  // Ported from Next.js: https://github.com/vercel/next.js/pull/93209
  //
  // IMPORTANT: The useRef+useEffect sync pattern has a subtle timing gap:
  // during the first render, onLoadRef.current holds the initial value from
  // useRef(onLoad), and the useEffect to sync it runs AFTER the layout effect.
  // This means on first mount the layout effect reads the correct initial
  // value (passed to useRef). If someone changes useRef(onLoad) to
  // useRef(undefined), the layout effect would read undefined on first mount.
  const onLoadRef = useRef(onLoad);
  useEffect(() => {
    onLoadRef.current = onLoad;
  }, [onLoad]);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);
  const onLoadingCompleteRef = useRef(onLoadingComplete);
  useEffect(() => {
    onLoadingCompleteRef.current = onLoadingComplete;
  }, [onLoadingComplete]);

  const {
    src,
    width: imgWidth,
    height: imgHeight,
    blurDataURL: imgBlurDataURL,
  } = resolveImageSource({ src: srcProp, width, height, blurDataURL });
  const shouldPreload = preload === true || priority === true;
  const priorityFetchPriority = priority ? "high" : undefined;
  const imageLoading = priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy");

  const [completedBlurSrc, setCompletedBlurSrc] = useState<string | undefined>(undefined);
  const blurComplete = completedBlurSrc === src;

  const markBlurComplete = () => {
    if (placeholder !== "blur") return;
    setCompletedBlurSrc((current) => (current === src ? current : src));
  };

  useNonWarningLayoutEffect(() => {
    if (!didInsertRef.current && imgElementRef.current !== null) {
      const img = imgElementRef.current;
      // Replay error events lost during SSR/hydration.
      if (onErrorRef.current) {
        // eslint-disable-next-line no-self-assign
        img.src = img.src;
      }
      // Replay onLoad for images that completed loading before React hydrated
      // (e.g. SSR streaming where the image arrives and renders before hydration
      // finishes). Without this, onLoad never fires for those images.
      //
      // img.complete is true for both successfully-loaded and errored images
      // (the HTML spec defines complete as true when the browser finished
      // fetching, regardless of outcome). We must check naturalWidth > 0 to
      // distinguish success from error — a failed image has naturalWidth === 0.
      // Ported from Next.js: https://github.com/vercel/next.js/pull/93209
      if (img.complete && img.naturalWidth > 0) {
        markBlurComplete();
        const currentOnLoad = onLoadRef.current;
        const currentOnLoadingComplete = onLoadingCompleteRef.current;
        if (currentOnLoad || currentOnLoadingComplete) {
          // Dedup — fire at most once per src per mount, matching onLoad dedup
          if (lastLoadedSrcRef.current !== src) {
            lastLoadedSrcRef.current = src;
            // Create a synthetic React event with the expected shape.
            // next/image uses a similar pattern in `handleLoading`.
            const syntheticEvent = createSyntheticLoadEvent(img);
            currentOnLoad?.(syntheticEvent);
            currentOnLoadingComplete?.(img);
          }
        }
      }
      didInsertRef.current = true;
    }
  }, [placeholder, sizes, _unoptimized]);

  // Wire onLoadingComplete (deprecated) into onLoad — matches Next.js behavior.
  // onLoad fires first, then onLoadingComplete receives the HTMLImageElement.
  const handleLoad = onLoadingComplete
    ? (e: React.SyntheticEvent<HTMLImageElement>) => {
        if (lastLoadedSrcRef.current === src) return;
        lastLoadedSrcRef.current = src;
        markBlurComplete();
        onLoad?.(e);
        onLoadingComplete(e.currentTarget);
      }
    : onLoad
      ? (e: React.SyntheticEvent<HTMLImageElement>) => {
          if (lastLoadedSrcRef.current === src) return;
          lastLoadedSrcRef.current = src;
          markBlurComplete();
          onLoad(e);
        }
      : placeholder === "blur"
        ? () => {
            if (lastLoadedSrcRef.current === src) return;
            lastLoadedSrcRef.current = src;
            markBlurComplete();
          }
        : undefined;

  const handleError = onError
    ? (e: React.SyntheticEvent<HTMLImageElement>) => {
        if (lastErrorSrcRef.current === src) return;
        lastErrorSrcRef.current = src;
        markBlurComplete();
        onError(e);
      }
    : placeholder === "blur"
      ? () => {
          if (lastErrorSrcRef.current === src) return;
          lastErrorSrcRef.current = src;
          markBlurComplete();
        }
      : undefined;

  if (_unoptimized === true || __globallyUnoptimized) {
    // Unoptimized images are fetched directly by the browser, so intentionally
    // skip remote URL validation: there is no server-side optimizer fetch and
    // therefore no SSRF surface. This matches Next.js behavior.
    const renderedSrc = overrideSrc || src;
    const sanitizedBlur = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
    const blurStyle =
      !blurComplete && placeholder === "blur" && sanitizedBlur
        ? {
            backgroundImage: `url(${sanitizedBlur})`,
            backgroundSize: "cover",
            backgroundRepeat: "no-repeat",
            backgroundPosition: "center",
          }
        : undefined;
    preloadImageResource({
      shouldPreload,
      src: renderedSrc,
      fetchPriority: priorityFetchPriority,
    });
    return (
      <img
        ref={mergedRef}
        src={renderedSrc}
        alt={alt}
        width={fill ? undefined : imgWidth}
        height={fill ? undefined : imgHeight}
        loading={imageLoading}
        fetchPriority={priorityFetchPriority}
        decoding="async"
        className={className}
        data-nimg={fill ? "fill" : "1"}
        onLoad={handleLoad}
        onError={handleError}
        style={fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style }}
        {...rest}
      />
    );
  }

  // If a custom loader is provided, use basic img with loader URL
  if (loader) {
    const resolvedQuality = typeof quality === "string" ? Number(quality) : (quality ?? 75);
    const resolvedSrc = loader({ src, width: imgWidth ?? 0, quality: resolvedQuality });
    preloadImageResource({
      shouldPreload,
      src: resolvedSrc,
      sizes,
      fetchPriority: priorityFetchPriority,
    });
    return (
      <img
        ref={mergedRef}
        src={resolvedSrc}
        alt={alt}
        width={fill ? undefined : imgWidth}
        height={fill ? undefined : imgHeight}
        loading={imageLoading}
        decoding="async"
        sizes={sizes}
        className={className}
        onLoad={handleLoad}
        onError={handleError}
        style={fill ? getFillStyle(style) : style}
        {...rest}
      />
    );
  }

  // For remote URLs, validate against remotePatterns. Non-fill images use
  // @unpic/react for CDN URL transforms; fill uses a plain img so the DOM
  // element keeps Next.js's absolute-positioned fill contract.
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
    const showBlur = !blurComplete && placeholder === "blur" && sanitizedBlur;
    const blurStyle = showBlur
      ? {
          backgroundImage: `url(${sanitizedBlur})`,
          backgroundSize: "cover",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
        }
      : undefined;
    const bg = showBlur ? `url(${sanitizedBlur})` : undefined;

    if (fill) {
      const imageSizes = sizes ?? "100vw";
      preloadImageResource({
        shouldPreload,
        src,
        sizes: imageSizes,
        fetchPriority: priorityFetchPriority,
      });
      return (
        <img
          ref={mergedRef}
          src={src}
          alt={alt}
          // `priority` is a Next.js concept — translate it to HTML attributes so
          // it is never forwarded to the DOM as a non-boolean attribute, which
          // would trigger React's "Received `true` for a non-boolean attribute"
          // warning.
          loading={imageLoading}
          fetchPriority={priorityFetchPriority}
          decoding="async"
          sizes={imageSizes}
          className={className}
          data-nimg="fill"
          onLoad={handleLoad}
          onError={handleError}
          style={getFillStyle(style, blurStyle)}
          {...rest}
        />
      );
    }
    // constrained layout requires width+height or aspectRatio
    if (imgWidth && imgHeight) {
      // @unpic/react forwards additional image props through transformProps and
      // merges `style` with generated layout styles at runtime, but its public
      // React type omits `style`.
      const unpicRuntimeStyleProps: { style?: React.CSSProperties } = { style };
      preloadImageResource({
        shouldPreload,
        src,
        sizes,
        fetchPriority: priorityFetchPriority,
      });
      return (
        <UnpicImage
          src={src}
          alt={alt}
          width={imgWidth}
          height={imgHeight}
          layout="constrained"
          // Same translation as above — never pass `priority` to the DOM.
          loading={imageLoading}
          fetchPriority={priorityFetchPriority}
          sizes={sizes}
          className={className}
          {...unpicRuntimeStyleProps}
          background={bg}
          onLoad={handleLoad}
          onError={handleError}
          ref={mergedRef}
        />
      );
    }
    // Fall through to basic <img> if dimensions not provided
    // (unpic requires them for constrained layout)
  }

  // Route local images through the /_next/image optimization endpoint.
  // In production on Cloudflare Workers, this resizes and transcodes via
  // the Images binding. In dev, it serves the original file as a passthrough.
  // When `unoptimized` is true, bypass the endpoint entirely (Next.js compat).
  // SVG sources auto-skip unless dangerouslyAllowSVG is enabled, matching
  // Next.js behavior where .svg triggers unoptimized=true by default.
  const imgQuality = typeof quality === "string" ? Number(quality) : (quality ?? 75);
  const isSvg = isSvgUrl(src);
  const skipOptimization = isSvg && !__dangerouslyAllowSVG;

  // Build srcSet for responsive local images (common breakpoints).
  // Each entry points to /_next/image with the appropriate width.
  const optimizedAttributes =
    imgWidth && !fill && !skipOptimization
      ? generateImageAttributes(src, imgWidth, imgQuality, sizes)
      : undefined;
  const srcSet = optimizedAttributes
    ? optimizedAttributes.srcSet
    : imgWidth && !fill
      ? RESPONSIVE_WIDTHS.filter((w) => w <= imgWidth * 2)
          .map((w) => `${src} ${w}w`)
          .join(", ") || `${src} ${imgWidth}w`
      : undefined;

  // The main `src` also goes through the optimization endpoint. Use the
  // declared width (or the first responsive width as fallback).
  const optimizedSrc = skipOptimization
    ? src
    : optimizedAttributes
      ? optimizedAttributes.src
      : imageOptimizationUrl(src, RESPONSIVE_WIDTHS[0], imgQuality);

  // Blur placeholder: show a low-quality background while the image loads.
  // Sanitize blurDataURL to prevent CSS injection via crafted data URLs.
  const sanitizedLocalBlur = imgBlurDataURL ? sanitizeBlurDataURL(imgBlurDataURL) : undefined;
  const blurStyle =
    !blurComplete && placeholder === "blur" && sanitizedLocalBlur
      ? {
          backgroundImage: `url(${sanitizedLocalBlur})`,
          backgroundSize: "cover",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "center",
        }
      : undefined;

  const imageSizes = sizes ?? (fill ? "100vw" : undefined);
  preloadImageResource({
    shouldPreload,
    src: optimizedSrc,
    srcSet,
    sizes: imageSizes,
    fetchPriority: priorityFetchPriority,
  });

  // For local images, render a standard <img> tag with srcSet and blur support.
  // The src and srcSet point to the /_next/image optimization endpoint.
  return (
    <img
      ref={mergedRef}
      src={optimizedSrc}
      alt={alt}
      width={fill ? undefined : imgWidth}
      height={fill ? undefined : imgHeight}
      loading={imageLoading}
      fetchPriority={priorityFetchPriority}
      decoding="async"
      srcSet={srcSet}
      sizes={imageSizes}
      className={className}
      data-nimg={fill ? "fill" : "1"}
      onLoad={handleLoad}
      onError={handleError}
      style={fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style }}
      {...rest}
    />
  );
});

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

export default Image;
