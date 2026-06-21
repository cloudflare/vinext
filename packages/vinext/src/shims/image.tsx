"use client";

/**
 * next/image shim
 *
 * Translates Next.js Image props to an img element whose generated attributes
 * match Next.js. Optimized images route through `/_next/image` for resizing,
 * format negotiation, and quality selection.
 *
 * Remote images are validated against `images.remotePatterns` and
 * `images.domains` from next.config.js during development. Production emits
 * optimizer URLs and leaves authorization to the server endpoint, matching
 * Next.js behavior.
 */
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as ReactDOM from "react-dom";
import { appendDeploymentIdQuery, getDeploymentId } from "../utils/deployment-id.js";
import {
  hasLocalMatch,
  hasRemoteMatch,
  type LocalPattern,
  type RemotePattern,
} from "./image-config.js";
import { useMergedRef } from "./use-merged-ref.js";
import configuredImageLoader from "vinext/shims/image-loader";

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
const __imageLocalPatterns: LocalPattern[] = (() => {
  try {
    return JSON.parse(
      process.env.__VINEXT_IMAGE_LOCAL_PATTERNS ?? '[{"pathname":"**","search":""}]',
    );
  } catch {
    return [{ pathname: "**", search: "" }];
  }
})();
const __imageDomains: string[] = (() => {
  try {
    return JSON.parse(process.env.__VINEXT_IMAGE_DOMAINS ?? "[]");
  } catch {
    return [];
  }
})();
const __rejectLocalQueryWithoutPattern =
  process.env.__VINEXT_IMAGE_REJECT_LOCAL_QUERY_WITHOUT_PATTERN === "true";
const __isDev = process.env.NODE_ENV !== "production";
const __shouldValidatePatterns = process.env.NODE_ENV !== "test";
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
const __imageQualities: number[] = (() => {
  try {
    const qualities = JSON.parse(process.env.__VINEXT_IMAGE_QUALITIES ?? "[75]");
    return Array.isArray(qualities) && qualities.length > 0 ? qualities : [75];
  } catch {
    return [75];
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
const __imageUnoptimized = process.env.__VINEXT_IMAGE_UNOPTIMIZED === "true";
const __imagePath = process.env.__VINEXT_IMAGE_PATH ?? "/_next/image";

type ImageLoader = (params: { src: string; width: number; quality?: number }) => string;

function isDefaultImageLoader(loader: ImageLoader): boolean {
  return "__next_img_default" in loader;
}

function findClosestQuality(quality: number | undefined): number {
  const requestedQuality = quality || 75;
  return __imageQualities.reduce((closest, candidate) =>
    Math.abs(candidate - requestedQuality) < Math.abs(closest - requestedQuality)
      ? candidate
      : closest,
  );
}

function validateLocalUrl(src: string): void {
  const localSrc = extractLocalDeploymentId(src).src;
  if (!localSrc.startsWith("/") || localSrc.startsWith("//")) return;

  if (localSrc.includes("?") && __rejectLocalQueryWithoutPattern) {
    throw new Error(
      `Image with src "${src}" is using a query string which is not configured in images.localPatterns.\nRead more: https://nextjs.org/docs/messages/next-image-unconfigured-localpatterns`,
    );
  }

  if (!__isDev || !__shouldValidatePatterns || hasLocalMatch(__imageLocalPatterns, localSrc))
    return;

  throw new Error(
    `Invalid src prop (${src}) on \`next/image\` does not match \`images.localPatterns\` configured in your \`next.config.js\`\nSee more info: https://nextjs.org/docs/messages/next-image-unconfigured-localpatterns`,
  );
}

/**
 * Validate that a remote URL is allowed by the configured remote patterns.
 * Returns true if the URL is allowed, false otherwise.
 *
 * Only URLs matching configured remotePatterns/domains are allowed. Next.js
 * defaults both lists to empty, which denies all remote image optimization.
 * Validation is only performed by the component in development. In production,
 * Next.js still emits the optimizer URL and lets the image endpoint reject it.
 *
 * Private-address rejection belongs to the server-side optimizer, which can
 * validate the resolved address instead of changing component render behavior.
 */
function validateRemoteUrl(src: string): void {
  if (src.startsWith("//")) {
    throw new Error(
      `Failed to parse src "${src}" on \`next/image\`, protocol-relative URL (//) must be changed to an absolute URL (http:// or https://)`,
    );
  }

  let url: URL;
  try {
    url = new URL(src);
  } catch {
    throw new Error(
      `Failed to parse src "${src}" on \`next/image\`, if using relative image it must start with a leading slash "/" or be an absolute URL (http:// or https://)`,
    );
  }

  if (!__shouldValidatePatterns || hasRemoteMatch(__imageDomains, __imageRemotePatterns, url))
    return;

  throw new Error(
    `Invalid src prop (${src}) on \`next/image\`, hostname "${url.hostname}" is not configured under images in your \`next.config.js\`\nSee more info: https://nextjs.org/docs/messages/next-image-unconfigured-host`,
  );
}

function validateDefaultLoaderSource(src: string): void {
  if (__isDev && src.startsWith("//")) validateRemoteUrl(src);
  validateLocalUrl(src);
  if (__isDev && !src.startsWith("/")) validateRemoteUrl(src);
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
const RESPONSIVE_WIDTHS = [...__imageDeviceSizes].sort((a, b) => a - b);
const FIXED_IMAGE_WIDTHS = [...__imageSizes].sort((a, b) => a - b);
const ALL_IMAGE_WIDTHS = [...RESPONSIVE_WIDTHS, ...FIXED_IMAGE_WIDTHS].sort((a, b) => a - b);

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
  const localSource = extractLocalDeploymentId(src);
  return `${__imagePath}?url=${encodeURIComponent(localSource.src)}&w=${width}&q=${quality}${
    localSource.src.startsWith("/") && localSource.deploymentId
      ? `&dpl=${localSource.deploymentId}`
      : ""
  }`;
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
function getImageWidths(
  width: number | undefined,
  sizes: string | undefined,
): { widths: number[]; kind: "w" | "x" } {
  if (sizes) {
    const viewportWidthPattern = /(^|\s)(1?\d?\d)vw/g;
    const viewportPercentages: number[] = [];
    for (let match; (match = viewportWidthPattern.exec(sizes)); ) {
      viewportPercentages.push(Number.parseInt(match[2], 10));
    }
    if (viewportPercentages.length > 0) {
      const smallestRatio = Math.min(...viewportPercentages) * 0.01;
      return {
        widths: ALL_IMAGE_WIDTHS.filter(
          (configuredWidth) => configuredWidth >= RESPONSIVE_WIDTHS[0] * smallestRatio,
        ),
        kind: "w",
      };
    }
    return { widths: ALL_IMAGE_WIDTHS, kind: "w" };
  }
  if (width === undefined) return { widths: RESPONSIVE_WIDTHS, kind: "w" };
  return {
    widths: [
      ...new Set(
        [width, width * 2].map(
          (targetWidth) =>
            ALL_IMAGE_WIDTHS.find((configuredWidth) => configuredWidth >= targetWidth) ??
            ALL_IMAGE_WIDTHS[ALL_IMAGE_WIDTHS.length - 1],
        ),
      ),
    ],
    kind: "x",
  };
}

function generateResponsiveImageAttributes(
  width: number | undefined,
  sizes: string | undefined,
  generateUrl: (width: number) => string,
): { src: string; srcSet: string; sizes: string | undefined } {
  const { widths, kind } = getImageWidths(width, sizes);
  return {
    sizes: !sizes && kind === "w" ? "100vw" : sizes,
    srcSet: widths
      .map(
        (candidateWidth, index) =>
          `${generateUrl(candidateWidth)} ${kind === "w" ? candidateWidth : index + 1}${kind}`,
      )
      .join(", "),
    src: generateUrl(widths[widths.length - 1]),
  };
}

function generateImageAttributes(
  src: string,
  width: number | undefined,
  sizes: string | undefined,
  quality: number,
): { src: string; srcSet: string; sizes: string | undefined } {
  return generateResponsiveImageAttributes(width, sizes, (candidateWidth) =>
    imageOptimizationUrl(src, candidateWidth, quality),
  );
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
  const isSpecialSource = !src || src.startsWith("data:") || src.startsWith("blob:");
  const effectiveLoader = loader ?? configuredImageLoader;
  const isDefaultLoader = isDefaultImageLoader(effectiveLoader);
  const isDefaultLoaderSvg = isDefaultLoader && isSvgUrl(src) && !__dangerouslyAllowSVG;
  const effectiveUnoptimized =
    _unoptimized === true || __imageUnoptimized || isSpecialSource || isDefaultLoaderSvg;
  const imageLoading = isSpecialSource
    ? undefined
    : priority
      ? "eager"
      : shouldPreload
        ? loading
        : (loading ?? "lazy");

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

  if (effectiveUnoptimized) {
    // Unoptimized images are fetched directly by the browser, so intentionally
    // skip remote URL validation: there is no server-side optimizer fetch and
    // therefore no SSRF surface. This matches Next.js behavior.
    const renderedSrc =
      overrideSrc ||
      (src.startsWith("/") && !src.startsWith("//") ? appendDeploymentIdQuery(src) : src);
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

  // For remote URLs, validate against remotePatterns before passing the source
  // through the same default optimizer URL generation as local images.
  if (isDefaultLoader) validateDefaultLoaderSource(src);

  // Route local images through the /_next/image optimization endpoint.
  // In production on Cloudflare Workers, this resizes and transcodes via
  // the Images binding. In dev, it serves the original file as a passthrough.
  // When `unoptimized` is true, bypass the endpoint entirely (Next.js compat).
  // Default-loader SVG sources have already taken the unoptimized path above.
  // Custom loaders continue to process SVG sources normally.
  const imgQuality = findClosestQuality(quality);

  // Build srcSet for responsive local images (common breakpoints).
  // Each entry points to /_next/image with the appropriate width.
  const optimizedAttributes = !isDefaultLoader
    ? generateResponsiveImageAttributes(imgWidth, sizes, (candidateWidth) =>
        effectiveLoader({ src, width: candidateWidth, quality }),
      )
    : generateImageAttributes(src, fill ? undefined : imgWidth, sizes, imgQuality);
  const srcSet = optimizedAttributes.srcSet;

  // The main `src` also goes through the optimization endpoint. Use the
  // declared width (or the first responsive width as fallback).
  const optimizedSrc = optimizedAttributes?.src ?? src;
  const renderedSrc = overrideSrc || optimizedSrc;

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

  const imageSizes = optimizedAttributes?.sizes ?? sizes ?? (fill ? "100vw" : undefined);
  preloadImageResource({
    shouldPreload,
    src: renderedSrc,
    srcSet,
    sizes: imageSizes,
    fetchPriority: priorityFetchPriority,
  });

  // For local images, render a standard <img> tag with srcSet and blur support.
  // The src and srcSet point to the /_next/image optimization endpoint.
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
  const isSpecialSource = !src || src.startsWith("data:") || src.startsWith("blob:");
  const effectiveLoader = loader ?? configuredImageLoader;
  const isDefaultLoader = isDefaultImageLoader(effectiveLoader);
  const isDefaultLoaderSvg = isDefaultLoader && isSvgUrl(src) && !__dangerouslyAllowSVG;
  const effectiveUnoptimized =
    _unoptimized === true || __imageUnoptimized || isSpecialSource || isDefaultLoaderSvg;

  if (effectiveUnoptimized) {
    // As in the component path, unoptimized images never reach the server-side
    // optimizer, so remote URL validation is intentionally unnecessary.
    const renderedSrc =
      overrideSrc ||
      (src.startsWith("/") && !src.startsWith("//") ? appendDeploymentIdQuery(src) : src);
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
        src: renderedSrc,
        alt,
        width: fill ? undefined : imgWidth,
        height: fill ? undefined : imgHeight,
        loading: isSpecialSource
          ? undefined
          : priority
            ? "eager"
            : shouldPreload
              ? loading
              : (loading ?? "lazy"),
        fetchPriority: priority ? ("high" as const) : undefined,
        decoding: "async" as const,
        className,
        "data-nimg": fill ? "fill" : "1",
        style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
        ...rest,
      } as React.ImgHTMLAttributes<HTMLImageElement>,
    };
  }

  if (isDefaultLoader) validateDefaultLoaderSource(src);

  const imgQuality = findClosestQuality(_quality);
  const customAttributes = !isDefaultLoader
    ? generateResponsiveImageAttributes(imgWidth, sizes, (candidateWidth) =>
        effectiveLoader({ src, width: candidateWidth, quality: _quality }),
      )
    : undefined;

  const optimizedAttributes = !isDefaultLoader
    ? customAttributes
    : generateImageAttributes(src, fill ? undefined : imgWidth, sizes, imgQuality);

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
      src: overrideSrc || optimizedAttributes?.src || src,
      alt,
      width: fill ? undefined : imgWidth,
      height: fill ? undefined : imgHeight,
      loading: priority ? "eager" : shouldPreload ? loading : (loading ?? "lazy"),
      fetchPriority: priority ? ("high" as const) : undefined,
      decoding: "async" as const,
      srcSet: optimizedAttributes?.srcSet,
      sizes: optimizedAttributes?.sizes ?? sizes ?? (fill ? "100vw" : undefined),
      className,
      "data-nimg": fill ? "fill" : "1",
      style: fill ? getFillStyle(style, blurStyle) : { ...blurStyle, ...style },
      ...rest,
    } as React.ImgHTMLAttributes<HTMLImageElement>,
  };
}

export default Image;
