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
  customLoaderUrlBuilder,
  generateImageAttributes,
  getImageStyle,
  imageOptimizationUrl,
  isDataOrBlobUrl,
  isRemoteUrl,
  isSvgUrl,
  parseImageQuality,
  resolveCustomImageLoader,
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

const warnedMessages = new Set<string>();

function warnOnce(message: string): void {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(message);
}

/**
 * Dev-only check that a loaded `fill` image without a narrower `sizes` is
 * actually rendered close to the viewport width.
 * Ported from Next.js `handleLoading` in packages/next/src/client/image-component.tsx.
 */
function warnFillImageSizes(img: HTMLImageElement, sizesInput: string | undefined): void {
  if (sizesInput && sizesInput !== "100vw") return;
  const widthViewportRatio = img.getBoundingClientRect().width / window.innerWidth;
  if (widthViewportRatio >= 0.6) return;
  const src = img.src;
  const origSrc = new URL(src, "http://n").searchParams.get("url") || src;
  if (sizesInput === "100vw") {
    warnOnce(
      `Image with src "${origSrc}" has "fill" prop and "sizes" prop of "100vw", but image is not rendered at full viewport width. Please adjust "sizes" to improve page performance. Read more: https://nextjs.org/docs/api-reference/next/image#sizes`,
    );
  } else {
    warnOnce(
      `Image with src "${origSrc}" has "fill" but is missing "sizes" prop. Please add it to improve page performance. Read more: https://nextjs.org/docs/api-reference/next/image#sizes`,
    );
  }
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

/** `layout` of a next/legacy/image, which picks its srcSet widths. */
export type LegacyImageLayout = "fill" | "fixed" | "intrinsic" | "responsive" | "raw";

function ImageRender(
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
    // Deprecated props: Next.js consumes them and applies them to fill images only.
    objectFit,
    objectPosition,
    ...rest
  }: ImageProps,
  ref: React.ForwardedRef<HTMLImageElement>,
  // Set for next/legacy/image, which never uses images.loaderFile.
  legacyLayout: LegacyImageLayout | undefined,
) {
  const ignoreLoaderFile = legacyLayout !== undefined;
  // Dedup refs: ensure onLoad and onError fire at most once per src per mount.
  // Matches Next.js behavior — prevents double-firing from React re-renders,
  // strict-mode double-invocation, or state updates inside the handler itself.
  // Ported from Next.js: https://github.com/vercel/next.js/pull/93209
  const legacyFill = { objectFit, objectPosition };
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
  const customLoader = resolveCustomImageLoader(loader, src, ignoreLoaderFile);
  const shouldPreload = preload === true || priority === true;
  const priorityFetchPriority = priority ? "high" : undefined;
  // data: and blob: sources are served as-is and never lazy by default (Next.js parity).
  const isInlineSrc = isDataOrBlobUrl(src);
  const imageLoading = priority
    ? "eager"
    : shouldPreload || isInlineSrc
      ? loading
      : (loading ?? "lazy");

  // Next.js treats these sources as unoptimized and skips the fill sizes check.
  const isUnoptimized =
    _unoptimized === true ||
    __globallyUnoptimized ||
    !src ||
    isInlineSrc ||
    (!customLoader && !__dangerouslyAllowSVG && isSvgUrl(src));
  const checkFillSizes =
    __isDev && fill && !isUnoptimized
      ? (img: HTMLImageElement) => warnFillImageSizes(img, sizes)
      : undefined;

  const [completedBlurSrc, setCompletedBlurSrc] = useState<string | undefined>(undefined);
  const blurComplete = completedBlurSrc === src;

  // Next.js keeps the alt text transparent until the image fails to load
  // (image-component.tsx: `showAltText`, set by the img's error handler).
  const [showAltText, setShowAltText] = useState(false);

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
        checkFillSizes?.(img);
      }
      didInsertRef.current = true;
    }
  }, [placeholder, sizes, _unoptimized]);

  // Wire onLoadingComplete (deprecated) into onLoad — matches Next.js behavior.
  // onLoad fires first, then onLoadingComplete receives the HTMLImageElement.
  const handleUserLoad = onLoadingComplete
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
  const handleLoad = checkFillSizes
    ? (e: React.SyntheticEvent<HTMLImageElement>) => {
        handleUserLoad?.(e);
        checkFillSizes(e.currentTarget);
      }
    : handleUserLoad;

  const handleError = (e: React.SyntheticEvent<HTMLImageElement>) => {
    // If the real image fails to load, this will ensure "alt" is visible.
    setShowAltText(true);
    if (lastErrorSrcRef.current === src) return;
    lastErrorSrcRef.current = src;
    markBlurComplete();
    onError?.(e);
  };

  if (_unoptimized === true || __globallyUnoptimized || isInlineSrc) {
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
        onLoad={handleLoad}
        onError={handleError}
        style={getImageStyle(fill, style, blurStyle, legacyFill, showAltText)}
        {...rest}
        data-nimg={fill ? "fill" : "1"}
      />
    );
  }

  // For remote URLs, validate against remotePatterns. Non-fill images use
  // @unpic/react for CDN URL transforms; fill uses a plain img so the DOM
  // element keeps Next.js's absolute-positioned fill contract. A custom loader
  // builds remote URLs itself, so it skips this (Next.js only checks remote
  // patterns in its default loader).
  if (!customLoader && isRemoteUrl(src)) {
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
          onLoad={handleLoad}
          onError={handleError}
          style={getImageStyle(true, style, blurStyle, legacyFill, showAltText)}
          {...rest}
          data-nimg="fill"
        />
      );
    }
    // constrained layout requires width+height or aspectRatio
    if (imgWidth && imgHeight) {
      // @unpic/react forwards additional image props through transformProps and
      // merges `style` with generated layout styles at runtime, but its public
      // React type omits `style`.
      const unpicRuntimeStyleProps: { style?: React.CSSProperties } = {
        style: getImageStyle(false, style, undefined, undefined, showAltText),
      };
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
          data-nimg="1"
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
  //
  // A custom loader builds every src and srcSet URL instead, as in Next.js's
  // generateImgAttrs: it gets each srcSet width and the `quality` prop as
  // written (undefined when unset), and SVG sources are not skipped.
  // The default loader uses 75 for an unset quality.
  const imgQuality = parseImageQuality(quality);
  const skipOptimization = !customLoader && isSvgUrl(src) && !__dangerouslyAllowSVG;

  // Build srcSet for responsive local images (common breakpoints).
  // Each entry points to /_next/image with the appropriate width.
  const optimizedAttributes =
    (fill || imgWidth || customLoader) && !skipOptimization
      ? generateImageAttributes(
          src,
          fill ? undefined : imgWidth,
          imgQuality,
          sizes,
          customLoader ? customLoaderUrlBuilder(customLoader) : undefined,
          legacyLayout,
        )
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

  const imageSizes = sizes ?? (fill || legacyLayout === "responsive" ? "100vw" : undefined);
  preloadImageResource({
    shouldPreload,
    src: optimizedSrc,
    srcSet,
    sizes: imageSizes,
    fetchPriority: priorityFetchPriority,
  });

  // For local images, render a standard <img> tag with srcSet and blur support.
  // The src and srcSet point to the /_next/image optimization endpoint. As in
  // Next.js's generateImgAttrs, `src` follows `sizes` and `srcSet`: React sets
  // attributes in order, and Safari fetches `src` as soon as it is set.
  return (
    <img
      ref={mergedRef}
      alt={alt}
      width={fill ? undefined : imgWidth}
      height={fill ? undefined : imgHeight}
      loading={imageLoading}
      fetchPriority={priorityFetchPriority}
      decoding="async"
      className={className}
      onLoad={handleLoad}
      onError={handleError}
      style={getImageStyle(fill, style, blurStyle, legacyFill, showAltText)}
      sizes={imageSizes}
      srcSet={srcSet}
      src={optimizedSrc}
      {...rest}
      data-nimg={fill ? "fill" : "1"}
    />
  );
}

const ImageImpl = forwardRef<HTMLImageElement, ImageProps>(function Image(props, ref) {
  return ImageRender(props, ref, undefined);
});

/**
 * The Image that next/legacy/image renders. Next.js's legacy Image
 * (client/legacy/image.tsx) picks its loader from `images.loader`, never
 * loading `images.loaderFile`, and its `layout` decides the srcSet widths.
 */
export const LegacyBaseImage = forwardRef<
  HTMLImageElement,
  ImageProps & { legacyLayout: LegacyImageLayout }
>(function Image({ legacyLayout, ...props }, ref) {
  return ImageRender(props, ref, legacyLayout);
});

// Annotated so declaration emit references ImageProps by name and keeps its
// @deprecated tags (https://github.com/vercel/next.js/pull/98597).
const Image: React.ForwardRefExoticComponent<ImageProps & React.RefAttributes<HTMLImageElement>> =
  ImageImpl;

export default Image;
