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
import { hasRemoteMatch, isPrivateIp, type RemotePattern } from "./image-config.js";
import { useMergedRef } from "./use-merged-ref.js";

export type StaticImageData = {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
};

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

type ImageProps = {
  src: string | StaticImageData;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  preload?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
  loader?: (params: { src: string; width: number; quality?: number }) => string;
  sizes?: string;
  className?: string;
  style?: React.CSSProperties;
  onLoad?: React.ReactEventHandler<HTMLImageElement>;
  /** @deprecated Use onLoad instead. Still supported for migration compat. */
  onLoadingComplete?: (img: HTMLImageElement) => void;
  onError?: React.ReactEventHandler<HTMLImageElement>;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  id?: string;
  // Accept and ignore Next.js-specific props that don't apply
  unoptimized?: boolean;
  overrideSrc?: string;
  loading?: "lazy" | "eager";
};

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
  src: string | StaticImageData;
  width?: number;
  height?: number;
  blurDataURL?: string;
}): { src: string; width?: number; height?: number; blurDataURL?: string } {
  const src = typeof v.src === "string" ? v.src : v.src.src;
  const imgWidth = v.width ?? (typeof v.src === "object" ? v.src.width : undefined);
  const imgHeight = v.height ?? (typeof v.src === "object" ? v.src.height : undefined);
  const imgBlurDataURL =
    v.blurDataURL ?? (typeof v.src === "object" ? v.src.blurDataURL : undefined);
  return { src, width: imgWidth, height: imgHeight, blurDataURL: imgBlurDataURL };
}

/**
 * Responsive image widths matching Next.js's device sizes config.
 * These are the breakpoints used for srcSet generation.
 * Configurable via `images.deviceSizes` in next.config.js.
 */
const RESPONSIVE_WIDTHS = __imageDeviceSizes;

/**
 * Build a `/_next/image` optimization URL.
 *
 * In production (Cloudflare Workers), the worker intercepts this path and uses
 * the Images binding to resize/transcode on the fly. In dev, the Vite dev
 * server handles it as a passthrough (serves the original file).
 */
export function imageOptimizationUrl(src: string, width: number, quality: number = 75): string {
  return `/_next/image?url=${encodeURIComponent(src)}&w=${width}&q=${quality}`;
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
 * server can resize and transcode the image. Only includes widths that are
 * <= 2x the original image width to avoid pointless upscaling.
 */
function generateSrcSet(src: string, originalWidth: number, quality: number = 75): string {
  const widths = RESPONSIVE_WIDTHS.filter((w) => w <= originalWidth * 2);
  if (widths.length === 0)
    return `${imageOptimizationUrl(src, originalWidth, quality)} ${originalWidth}w`;
  return widths.map((w) => `${imageOptimizationUrl(src, w, quality)} ${w}w`).join(", ");
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
    overrideSrc: _overrideSrc,
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

  // If a custom loader is provided, use basic img with loader URL
  if (loader) {
    const resolvedSrc = loader({ src, width: imgWidth ?? 0, quality: quality ?? 75 });
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
      const fillSizes = sizes ?? "100vw";
      preloadImageResource({
        shouldPreload,
        src,
        sizes: fillSizes,
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
          sizes={fillSizes}
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
  const imgQuality = quality ?? 75;
  const isSvg = src.endsWith(".svg");
  const skipOptimization = _unoptimized === true || (isSvg && !__dangerouslyAllowSVG);

  // Build srcSet for responsive local images (common breakpoints).
  // Each entry points to /_next/image with the appropriate width.
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
export function getImageProps(props: ImageProps): {
  props: React.ImgHTMLAttributes<HTMLImageElement>;
} {
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
    overrideSrc: _overrideSrc,
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

  // Build srcSet for local images — each width points to /_next/image
  const srcSet =
    imgWidth && !fill && !isRemoteUrl(resolvedSrc) && !loader && !skipOpt
      ? generateSrcSet(resolvedSrc, imgWidth, imgQuality)
      : undefined;

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

  return {
    props: {
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
      "data-nimg": fill ? "fill" : "1",
      style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
      ...rest,
    } as React.ImgHTMLAttributes<HTMLImageElement>,
  };
}

export default Image;
