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
 *
 * Prop building lives in the server-safe `image-props.ts`. In the RSC
 * environment, next/image resolves to a server entry that exports
 * `getImageProps` from there and this module's Image as a client reference.
 */
import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as ReactDOM from "react-dom";
import { Image as UnpicImage } from "@unpic/react";
import type {
  ImageLoader,
  ImageProps as UpstreamImageProps,
  StaticImageData,
  StaticRequire,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
import {
  __dangerouslyAllowSVG,
  __globallyUnoptimized,
  __isDev,
  RESPONSIVE_WIDTHS,
  generateImageAttributes,
  getFillStyle,
  imageOptimizationUrl,
  isRemoteUrl,
  isSvgUrl,
  resolveImageSource,
  sanitizeBlurDataURL,
  validateRemoteUrl,
} from "./image-props.js";
import { useMergedRef } from "./use-merged-ref.js";

export type { ImageLoader, StaticImageData, StaticRequire };
export type ImageLoaderProps = Parameters<ImageLoader>[0];
export type ImageProps = UpstreamImageProps;

export { getImageProps, imageOptimizationUrl } from "./image-props.js";

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

export default Image;
