"use client";

/**
 * next/legacy/image shim
 *
 * A port of Next.js's legacy Image component
 * (packages/next/src/client/legacy/image.tsx), the pre-Next.js 13 API with the
 * `layout` prop. It renders the same markup: a wrapper span (and a sizer for
 * the intrinsic and responsive layouts) around an absolutely positioned img,
 * a `<noscript>` fallback for lazy and blur images, the blur placeholder, and
 * IntersectionObserver lazy loading that honours `lazyRoot` and
 * `lazyBoundary`.
 *
 * Differences from Next.js, all from vinext's shared image config:
 * - The image config comes from vinext's build-time defines (image-props.ts)
 *   rather than Next.js's ImageConfigContext.
 * - The default loader builds URLs with vinext's `imageOptimizationUrl`
 *   (basePath, trailingSlash, `dpl` and `images.qualities` handling).
 * - `images.loader` "imgix", "cloudinary" and "akamai" build URLs with the
 *   default loader, as vinext has no `images.path`.
 * - vinext generates no `blurDataURL` for static imports, so a static import
 *   with `placeholder="blur"` renders no placeholder (and no dev error).
 * - React 19 always has `ReactDOM.preload`, so Next.js's `<Head>` preload
 *   fallback for older React never renders and is left out. As in Next.js,
 *   React's server renderer preloads non-lazy images itself.
 *
 * This module is used by apps that ran the `next-image-to-legacy-image`
 * codemod when upgrading from Next.js 12.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageLoader,
  ImageLoaderProps,
  ImageProps,
  StaticImageData,
} from "@vinext/types/next/upstream/dist/client/legacy/image";
import { hasRemoteMatch } from "./image-config.js";
import {
  ALL_IMAGE_WIDTHS,
  RESPONSIVE_WIDTHS,
  __dangerouslyAllowSVG,
  __globallyUnoptimized,
  __imageDomains,
  __imageQualities,
  __imageRemotePatterns,
  imageOptimizationUrl,
  resolveCustomImageLoader,
} from "./image-props.js";

export type { ImageLoader, ImageLoaderProps, ImageProps, StaticImageData };

type LegacyImageConfig = {
  deviceSizes: number[];
  allSizes: number[];
  unoptimized: boolean;
  dangerouslyAllowSVG: boolean;
  qualities: number[] | null;
};

const imageConfig: LegacyImageConfig = {
  deviceSizes: RESPONSIVE_WIDTHS,
  allSizes: ALL_IMAGE_WIDTHS,
  unoptimized: __globallyUnoptimized,
  dangerouslyAllowSVG: __dangerouslyAllowSVG,
  qualities: __imageQualities,
};

const isDev = process.env.NODE_ENV !== "production";

const loadedImageURLs = new Set<string>();
const allImgs = new Map<string, { src: string; priority: boolean; placeholder: string }>();
let perfObserver: PerformanceObserver | undefined;
const emptyDataURL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const VALID_LOADING_VALUES = ["lazy", "eager", undefined] as const;
type LoadingValue = (typeof VALID_LOADING_VALUES)[number];

type ImageLoaderWithConfig = (resolverProps: ImageLoaderPropsWithConfig) => string;
type ImageLoaderPropsWithConfig = ImageLoaderProps & {
  config: Readonly<LegacyImageConfig>;
};

const warnedMessages = new Set<string>();

// Next.js's warnOnce (shared/lib/utils/warn-once.ts) only warns in development.
function warnOnce(message: string): void {
  if (!isDev || warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(message);
}

function defaultLoader({ config, src, width, quality }: ImageLoaderPropsWithConfig): string {
  if (!config.dangerouslyAllowSVG && src.split("?", 1)[0].endsWith(".svg")) {
    // Special case to make svg serve as-is to avoid proxying
    // through the built-in Image Optimization API.
    return src;
  }

  if (isDev) {
    const missingValues = [];

    // these should always be provided but make sure they are
    if (!src) missingValues.push("src");
    if (!width) missingValues.push("width");

    if (missingValues.length > 0) {
      throw new Error(
        `Next Image Optimization requires ${missingValues.join(
          ", ",
        )} to be provided. Make sure you pass them as props to the \`next/image\` component. Received: ${JSON.stringify(
          { src, width, quality },
        )}`,
      );
    }

    if (src.startsWith("//")) {
      throw new Error(
        `Failed to parse src "${src}" on \`next/image\`, protocol-relative URL (//) must be changed to an absolute URL (http:// or https://)`,
      );
    }

    if (!src.startsWith("/")) {
      let parsedSrc: URL;
      try {
        parsedSrc = new URL(src);
      } catch (err) {
        console.error(err);
        throw new Error(
          `Failed to parse src "${src}" on \`next/image\`, if using relative image it must start with a leading slash "/" or be an absolute URL (http:// or https://)`,
        );
      }

      if (!hasRemoteMatch(__imageDomains, __imageRemotePatterns, parsedSrc)) {
        throw new Error(
          `Invalid src prop (${src}) on \`next/image\`, hostname "${parsedSrc.hostname}" is not configured under images in your \`next.config.js\`\n` +
            `See more info: https://nextjs.org/docs/messages/next-image-unconfigured-host`,
        );
      }
    }
  }

  return imageOptimizationUrl(src, width, quality);
}

type LayoutValue = NonNullable<ImageProps["layout"]>;
const VALID_LAYOUT_VALUES = ["fill", "fixed", "intrinsic", "responsive", undefined] as const;

type PlaceholderValue = "blur" | "empty";

type OnLoadingComplete = NonNullable<ImageProps["onLoadingComplete"]>;

type ImgElementStyle = React.CSSProperties;

type ImgElementWithDataProp = HTMLImageElement & {
  "data-loaded-src": string | undefined;
};

type StaticRequire = { default: StaticImageData };
type StaticImport = StaticRequire | StaticImageData;

function isStaticRequire(src: StaticRequire | StaticImageData): src is StaticRequire {
  return (src as StaticRequire).default !== undefined;
}

function isStaticImageData(src: StaticRequire | StaticImageData): src is StaticImageData {
  return (src as StaticImageData).src !== undefined;
}

function isStaticImport(src: string | StaticImport): src is StaticImport {
  return (
    typeof src === "object" &&
    (isStaticRequire(src as StaticImport) || isStaticImageData(src as StaticImport))
  );
}

type GenImgAttrsResult = {
  src: string;
  srcSet: string | undefined;
  sizes: string | undefined;
};

type ImageElementProps = Omit<ImageProps, "src" | "loader" | "layout"> & {
  srcString: string;
  imgAttributes: GenImgAttrsResult;
  heightInt: number | undefined;
  widthInt: number | undefined;
  qualityInt: number | undefined;
  layout: LayoutValue;
  imgStyle: ImgElementStyle;
  blurStyle: ImgElementStyle;
  isLazy: boolean;
  loading: LoadingValue;
  config: LegacyImageConfig;
  unoptimized: boolean;
  loader: ImageLoaderWithConfig;
  placeholder: PlaceholderValue;
  onLoadingCompleteRef: React.MutableRefObject<OnLoadingComplete | undefined>;
  setBlurComplete: (b: boolean) => void;
  setIntersection: (img: HTMLImageElement | null) => void;
  isVisible: boolean;
  noscriptSizes: string | undefined;
};

function getWidths(
  { deviceSizes, allSizes }: LegacyImageConfig,
  width: number | undefined,
  layout: LayoutValue,
  sizes: string | undefined,
): { widths: number[]; kind: "w" | "x" } {
  if (sizes && (layout === "fill" || layout === "responsive")) {
    // Find all the "vw" percent sizes used in the sizes prop
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g;
    const percentSizes = [];
    for (let match; (match = viewportWidthRe.exec(sizes)); match) {
      percentSizes.push(parseInt(match[2], 10));
    }
    if (percentSizes.length) {
      const smallestRatio = Math.min(...percentSizes) * 0.01;
      return {
        widths: allSizes.filter((s) => s >= deviceSizes[0] * smallestRatio),
        kind: "w",
      };
    }
    return { widths: allSizes, kind: "w" };
  }
  if (typeof width !== "number" || layout === "fill" || layout === "responsive") {
    return { widths: deviceSizes, kind: "w" };
  }

  const widths = [
    ...new Set(
      // Like Next.js, cap the density at 2x: 3x images are visually the same
      // on most screens and take significantly more data.
      [width, width * 2].map((w) => allSizes.find((p) => p >= w) || allSizes[allSizes.length - 1]),
    ),
  ];
  return { widths, kind: "x" };
}

type GenImgAttrsData = {
  config: LegacyImageConfig;
  src: string;
  unoptimized: boolean;
  layout: LayoutValue;
  loader: ImageLoaderWithConfig;
  width?: number;
  quality?: number;
  sizes?: string;
};

function generateImgAttrs({
  config,
  src,
  unoptimized,
  layout,
  width,
  quality,
  sizes,
  loader,
}: GenImgAttrsData): GenImgAttrsResult {
  if (unoptimized) {
    return { src, srcSet: undefined, sizes: undefined };
  }

  const { widths, kind } = getWidths(config, width, layout, sizes);
  const last = widths.length - 1;

  return {
    sizes: !sizes && kind === "w" ? "100vw" : sizes,
    srcSet: widths
      .map(
        (w, i) =>
          `${loader({ config, src, quality, width: w })} ${kind === "w" ? w : i + 1}${kind}`,
      )
      .join(", "),

    // It's intended to keep `src` the last attribute because React updates
    // attributes in order. If we keep `src` the first one, Safari will
    // immediately start to fetch `src`, before `sizes` and `srcSet` are even
    // updated by React. That causes multiple unnecessary requests if `srcSet`
    // and `sizes` are defined.
    src: loader({ config, src, quality, width: widths[last] }),
  };
}

function getInt(x: unknown): number | undefined {
  if (typeof x === "number") {
    return x;
  }
  if (typeof x === "string") {
    return parseInt(x, 10);
  }
  return undefined;
}

function defaultImageLoader(loaderProps: ImageLoaderPropsWithConfig): string {
  // `images.loader: "custom"` with no `loader` prop throws once a URL is built,
  // so unoptimized images still render. Next.js's legacy Image never reads
  // `images.loaderFile`.
  const customLoader = resolveCustomImageLoader(undefined, loaderProps.src, true);
  if (customLoader) {
    const { config: _config, ...opts } = loaderProps;
    return customLoader(opts);
  }
  return defaultLoader(loaderProps);
}

// See https://stackoverflow.com/q/39777833/266535 for why we use this ref
// handler instead of the img's onLoad attribute.
function handleLoading(
  img: ImgElementWithDataProp,
  src: string,
  layout: LayoutValue,
  placeholder: PlaceholderValue,
  onLoadingCompleteRef: React.MutableRefObject<OnLoadingComplete | undefined>,
  setBlurComplete: (b: boolean) => void,
) {
  if (!img || img.src === emptyDataURL || img["data-loaded-src"] === src) {
    return;
  }
  img["data-loaded-src"] = src;
  const p = "decode" in img ? img.decode() : Promise.resolve();
  void p
    .catch(() => {})
    .then(() => {
      if (!img.parentNode) {
        // Exit early in case of race condition:
        // - onload() is called
        // - decode() is called but incomplete
        // - unmount is called
        // - decode() completes
        return;
      }
      loadedImageURLs.add(src);
      if (placeholder === "blur") {
        setBlurComplete(true);
      }
      if (onLoadingCompleteRef?.current) {
        const { naturalWidth, naturalHeight } = img;
        // Pass back read-only primitive values but not the
        // underlying DOM element because it could be misused.
        onLoadingCompleteRef.current({ naturalWidth, naturalHeight });
      }
      if (isDev) {
        if (img.parentElement?.parentElement) {
          const parent = getComputedStyle(img.parentElement.parentElement);
          if (!parent.position) {
            // The parent has not been rendered to the dom yet and therefore it has no position. Skip the warnings for such cases.
          } else if (layout === "responsive" && parent.display === "flex") {
            warnOnce(
              `Image with src "${src}" may not render properly as a child of a flex container. Consider wrapping the image with a div to configure the width.`,
            );
          } else if (
            layout === "fill" &&
            parent.position !== "relative" &&
            parent.position !== "fixed" &&
            parent.position !== "absolute"
          ) {
            warnOnce(
              `Image with src "${src}" may not render properly with a parent using position:"${parent.position}". Consider changing the parent style to position:"relative" with a width and height.`,
            );
          }
        }
      }
    });
}

// Ported from Next.js's useIntersection (client/use-intersection.tsx), which
// shares one IntersectionObserver per root and margin.
type ObserveCallback = (isVisible: boolean) => void;
type ObserverId = { root: Element | Document | null; margin: string };
type Observer = {
  id: ObserverId;
  observer: IntersectionObserver;
  elements: Map<Element, ObserveCallback>;
};

const hasIntersectionObserver = typeof IntersectionObserver === "function";
const observers = new Map<ObserverId, Observer>();
const idList: ObserverId[] = [];

function createObserver(options: IntersectionObserverInit): Observer {
  const id = { root: options.root || null, margin: options.rootMargin || "" };
  const existing = idList.find((obj) => obj.root === id.root && obj.margin === id.margin);
  if (existing) {
    const instance = observers.get(existing);
    if (instance) return instance;
  }

  const elements = new Map<Element, ObserveCallback>();
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const callback = elements.get(entry.target);
      const isVisible = entry.isIntersecting || entry.intersectionRatio > 0;
      if (callback && isVisible) {
        callback(isVisible);
      }
    });
  }, options);
  const instance = { id, observer, elements };
  idList.push(id);
  observers.set(id, instance);
  return instance;
}

function observe(
  element: Element,
  callback: ObserveCallback,
  options: IntersectionObserverInit,
): () => void {
  const { id, observer, elements } = createObserver(options);
  elements.set(element, callback);

  observer.observe(element);
  return function unobserve(): void {
    elements.delete(element);
    observer.unobserve(element);

    // Destroy observer when there's nothing left to watch:
    if (elements.size === 0) {
      observer.disconnect();
      observers.delete(id);
      const index = idList.findIndex((obj) => obj.root === id.root && obj.margin === id.margin);
      if (index > -1) {
        idList.splice(index, 1);
      }
    }
  };
}

// Next.js's requestIdleCallback polyfill (client/request-idle-callback.ts).
function requestIdle(cb: () => void): () => void {
  if (typeof self !== "undefined" && typeof self.requestIdleCallback === "function") {
    const handle = self.requestIdleCallback(cb);
    return () => self.cancelIdleCallback(handle);
  }
  const handle = setTimeout(cb, 1);
  return () => clearTimeout(handle);
}

function useIntersection<T extends Element>({
  rootRef,
  rootMargin,
  disabled,
}: {
  rootRef?: React.RefObject<HTMLElement | null> | null;
  rootMargin?: string;
  disabled?: boolean;
}): [(element: T | null) => void, boolean, () => void] {
  const isDisabled: boolean = disabled || !hasIntersectionObserver;

  const [visible, setVisible] = useState(false);
  const elementRef = useRef<T | null>(null);
  const setElement = useCallback((element: T | null) => {
    elementRef.current = element;
  }, []);

  useEffect(() => {
    if (hasIntersectionObserver) {
      if (isDisabled || visible) return;

      const element = elementRef.current;
      if (element && element.tagName) {
        return observe(element, (isVisible) => isVisible && setVisible(isVisible), {
          root: rootRef?.current,
          rootMargin,
        });
      }
    } else if (!visible) {
      return requestIdle(() => setVisible(true));
    }
    // Like Next.js, re-run when the observed element changes.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isDisabled, rootMargin, rootRef, visible, elementRef.current]);

  const resetVisible = useCallback(() => {
    setVisible(false);
  }, []);

  return [setElement, visible, resetVisible];
}

function ImageElement({
  imgAttributes,
  heightInt: _heightInt,
  widthInt,
  qualityInt,
  layout,
  className,
  imgStyle,
  blurStyle,
  isLazy,
  placeholder,
  loading,
  srcString,
  config,
  unoptimized,
  loader,
  onLoadingCompleteRef,
  setBlurComplete,
  setIntersection,
  onLoad,
  onError,
  isVisible: _isVisible,
  noscriptSizes,
  ...rest
}: ImageElementProps): React.ReactElement {
  loading = isLazy ? "lazy" : loading;
  const ref = useCallback(
    (img: ImgElementWithDataProp | null) => {
      if (isDev) {
        if (img && !srcString) {
          console.error(`Image is missing required "src" property:`, img);
        }
      }
      setIntersection(img);
      if (img?.complete) {
        handleLoading(img, srcString, layout, placeholder, onLoadingCompleteRef, setBlurComplete);
      }
    },
    [setIntersection, srcString, layout, placeholder, onLoadingCompleteRef, setBlurComplete],
  );
  return (
    <>
      <img
        {...rest}
        {...imgAttributes}
        decoding="async"
        data-nimg={layout}
        className={className}
        style={{ ...imgStyle, ...blurStyle }}
        ref={ref}
        onLoad={(event) => {
          const img = event.currentTarget as ImgElementWithDataProp;
          handleLoading(img, srcString, layout, placeholder, onLoadingCompleteRef, setBlurComplete);
          if (onLoad) {
            onLoad(event);
          }
        }}
        onError={(event) => {
          if (placeholder === "blur") {
            // If the real image fails to load, this will still remove the placeholder.
            setBlurComplete(true);
          }
          if (onError) {
            onError(event);
          }
        }}
      />
      {(isLazy || placeholder === "blur") && (
        <noscript>
          <img
            {...rest}
            loading={loading}
            decoding="async"
            data-nimg={layout}
            style={imgStyle}
            className={className}
            // It's intended to keep `loading` before `src` because React updates
            // props in order which causes Safari/Firefox to not lazy load properly.
            // See https://github.com/facebook/react/issues/25883
            {...generateImgAttrs({
              config,
              src: srcString,
              unoptimized,
              layout,
              width: widthInt,
              quality: qualityInt,
              sizes: noscriptSizes,
              loader,
            })}
          />
        </noscript>
      )}
    </>
  );
}

// Dev-only warning for a lazy LCP image without `priority`, started by the
// first legacy Image that renders in the browser.
function observeLargestContentfulPaint(): void {
  if (typeof window === "undefined" || perfObserver || !window.PerformanceObserver) return;
  perfObserver = new PerformanceObserver((entryList) => {
    for (const entry of entryList.getEntries()) {
      // `element` is on LargestContentfulPaint entries.
      const imgSrc =
        (entry as PerformanceEntry & { element?: { src?: string } }).element?.src || "";
      const lcpImage = allImgs.get(imgSrc);
      if (
        lcpImage &&
        !lcpImage.priority &&
        lcpImage.placeholder !== "blur" &&
        !lcpImage.src.startsWith("data:") &&
        !lcpImage.src.startsWith("blob:")
      ) {
        // https://web.dev/lcp/#measure-lcp-in-javascript
        warnOnce(
          `Image with src "${lcpImage.src}" was detected as the Largest Contentful Paint (LCP). Please add the "priority" property if this image is above the fold.` +
            `\nRead more: https://nextjs.org/docs/api-reference/next/legacy/image#priority`,
        );
      }
    }
  });
  try {
    perfObserver.observe({
      type: "largest-contentful-paint",
      buffered: true,
    });
  } catch (err) {
    // Log error but don't crash the app
    console.error(err);
  }
}

const useNonWarningLayoutEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * @deprecated The `next/legacy/image` component is deprecated and will be removed in a future version of Next.js. Please use `next/image` instead.
 */
export default function Image({
  src,
  sizes,
  unoptimized = false,
  priority = false,
  loading,
  lazyRoot = null,
  lazyBoundary,
  className,
  quality,
  width,
  height,
  style,
  objectFit,
  objectPosition,
  onLoadingComplete,
  placeholder = "empty",
  blurDataURL,
  ...all
}: ImageProps): React.ReactElement {
  const config = imageConfig;

  const rest: Partial<ImageProps> = all;
  let layout: LayoutValue = sizes ? "responsive" : "intrinsic";
  if ("layout" in rest) {
    // Override default layout if the user specified one:
    if (rest.layout) layout = rest.layout;

    // Remove property so it's not spread on <img>:
    delete rest.layout;
  }

  let loader: ImageLoaderWithConfig = defaultImageLoader;
  if ("loader" in rest) {
    if (rest.loader) {
      const customImageLoader = rest.loader;
      loader = (obj) => {
        const { config: _config, ...opts } = obj;
        // The config object is internal only so we must
        // not pass it to the user-defined loader()
        return customImageLoader(opts);
      };
    }
    // Remove property so it's not spread on <img>
    delete rest.loader;
  }

  let staticSrc = "";
  if (isStaticImport(src)) {
    const staticImageData = isStaticRequire(src) ? src.default : src;

    if (!staticImageData.src) {
      throw new Error(
        `An object should only be passed to the image component src parameter if it comes from a static image import. It must include src. Received ${JSON.stringify(
          staticImageData,
        )}`,
      );
    }
    blurDataURL = blurDataURL || staticImageData.blurDataURL;
    staticSrc = staticImageData.src;
    if (!layout || layout !== "fill") {
      height = height || staticImageData.height;
      width = width || staticImageData.width;
      if (!staticImageData.height || !staticImageData.width) {
        throw new Error(
          `An object should only be passed to the image component src parameter if it comes from a static image import. It must include height and width. Received ${JSON.stringify(
            staticImageData,
          )}`,
        );
      }
    }
  }
  const srcString: string = typeof src === "string" ? src : staticSrc;

  warnOnce(
    `Image with src "${srcString}" is using next/legacy/image which is deprecated and will be removed in a future version of Next.js.`,
  );

  let isLazy = !priority && (loading === "lazy" || typeof loading === "undefined");
  if (srcString.startsWith("data:") || srcString.startsWith("blob:")) {
    // https://developer.mozilla.org/docs/Web/HTTP/Basics_of_HTTP/Data_URIs
    unoptimized = true;
    isLazy = false;
  }
  if (typeof window !== "undefined" && loadedImageURLs.has(srcString)) {
    isLazy = false;
  }
  if (config.unoptimized) {
    unoptimized = true;
  }

  const [blurComplete, setBlurComplete] = useState(false);
  const [setIntersection, isIntersected, resetIntersected] = useIntersection<HTMLImageElement>({
    rootRef: lazyRoot,
    rootMargin: lazyBoundary || "200px",
    disabled: !isLazy,
  });
  const isVisible = !isLazy || isIntersected;

  const wrapperStyle: React.CSSProperties = {
    boxSizing: "border-box",
    display: "block",
    overflow: "hidden",
    width: "initial",
    height: "initial",
    background: "none",
    opacity: 1,
    border: 0,
    margin: 0,
    padding: 0,
  };
  const sizerStyle: React.CSSProperties = {
    boxSizing: "border-box",
    display: "block",
    width: "initial",
    height: "initial",
    background: "none",
    opacity: 1,
    border: 0,
    margin: 0,
    padding: 0,
  };
  let hasSizer = false;
  let sizerSvgUrl: string | undefined;
  const layoutStyle: ImgElementStyle = {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,

    boxSizing: "border-box",
    padding: 0,
    border: "none",
    margin: "auto",

    display: "block",
    width: 0,
    height: 0,
    minWidth: "100%",
    maxWidth: "100%",
    minHeight: "100%",
    maxHeight: "100%",

    objectFit,
    objectPosition,
  };

  let widthInt = getInt(width);
  let heightInt = getInt(height);
  const qualityInt = getInt(quality);

  if (isDev) {
    if (!srcString) {
      // React doesn't show the stack trace and there's
      // no `src` to help identify which image, so we
      // instead console.error(ref) during mount.
      widthInt = widthInt || 1;
      heightInt = heightInt || 1;
      unoptimized = true;
    } else {
      if (!(VALID_LAYOUT_VALUES as readonly unknown[]).includes(layout)) {
        throw new Error(
          `Image with src "${srcString}" has invalid "layout" property. Provided "${layout}" should be one of ${VALID_LAYOUT_VALUES.map(
            String,
          ).join(",")}.`,
        );
      }

      if (
        (typeof widthInt !== "undefined" && isNaN(widthInt)) ||
        (typeof heightInt !== "undefined" && isNaN(heightInt))
      ) {
        throw new Error(
          `Image with src "${srcString}" has invalid "width" or "height" property. These should be numeric values.`,
        );
      }
      if (layout === "fill" && (width || height)) {
        warnOnce(
          `Image with src "${srcString}" and "layout='fill'" has unused properties assigned. Please remove "width" and "height".`,
        );
      }
      if (!(VALID_LOADING_VALUES as readonly unknown[]).includes(loading)) {
        throw new Error(
          `Image with src "${srcString}" has invalid "loading" property. Provided "${loading}" should be one of ${VALID_LOADING_VALUES.map(
            String,
          ).join(",")}.`,
        );
      }
      if (priority && loading === "lazy") {
        throw new Error(
          `Image with src "${srcString}" has both "priority" and "loading='lazy'" properties. Only one should be used.`,
        );
      }
      if (sizes && layout !== "fill" && layout !== "responsive") {
        warnOnce(
          `Image with src "${srcString}" has "sizes" property but it will be ignored. Only use "sizes" with "layout='fill'" or "layout='responsive'"`,
        );
      }
      if (placeholder === "blur") {
        if (layout !== "fill" && (widthInt || 0) * (heightInt || 0) < 1600) {
          warnOnce(
            `Image with src "${srcString}" is smaller than 40x40. Consider removing the "placeholder='blur'" property to improve performance.`,
          );
        }
        // vinext does not generate a blurDataURL for static imports, where
        // Next.js always has one for the supported formats.
        if (!blurDataURL && typeof src === "string") {
          const VALID_BLUR_EXT = ["jpeg", "png", "webp", "avif"]; // should match next-image-loader

          throw new Error(
            `Image with src "${srcString}" has "placeholder='blur'" property but is missing the "blurDataURL" property.
          Possible solutions:
            - Add a "blurDataURL" property, the contents should be a small Data URL to represent the image
            - Change the "src" property to a static import with one of the supported file types: ${VALID_BLUR_EXT.join(
              ",",
            )} (animated images not supported)
            - Remove the "placeholder" property, effectively no blur effect
          Read more: https://nextjs.org/docs/messages/placeholder-blur-data-url`,
          );
        }
      }
      if ("ref" in rest) {
        warnOnce(
          `Image with src "${srcString}" is using unsupported "ref" property. Consider using the "onLoadingComplete" property instead.`,
        );
      }

      if (qualityInt && config.qualities && !config.qualities.includes(qualityInt)) {
        // Like Next.js, suggest the list sorted as strings.
        // oxlint-disable-next-line typescript/require-array-sort-compare
        const suggested = [...config.qualities, qualityInt].sort();
        warnOnce(
          `Image with src "${srcString}" is using quality "${qualityInt}" which is not configured in images.qualities [${config.qualities.join(", ")}]. Please update your config to [${suggested.join(", ")}].` +
            `\nRead more: https://nextjs.org/docs/messages/next-image-unconfigured-qualities`,
        );
      }

      if (!unoptimized && loader !== defaultImageLoader) {
        const urlStr = loader({
          config,
          src: srcString,
          width: widthInt || 400,
          quality: qualityInt || 75,
        });
        let url: URL | undefined;
        try {
          url = new URL(urlStr);
        } catch {}
        if (urlStr === srcString || (url && url.pathname === srcString && !url.search)) {
          warnOnce(
            `Image with src "${srcString}" has a "loader" property that does not implement width. Please implement it or use the "unoptimized" property instead.` +
              `\nRead more: https://nextjs.org/docs/messages/next-image-missing-loader-width`,
          );
        }
      }

      if (style) {
        const overwrittenStyles = Object.keys(style).filter((key) => key in layoutStyle);
        if (overwrittenStyles.length) {
          warnOnce(
            `Image with src ${srcString} is assigned the following styles, which are overwritten by automatically-generated styles: ${overwrittenStyles.join(
              ", ",
            )}`,
          );
        }
      }

      observeLargestContentfulPaint();
    }
  }
  const imgStyle = Object.assign({}, style, layoutStyle);
  // Like the dev check above, skip the placeholder when there is no
  // blurDataURL (a static import), rather than request `url("undefined")`.
  const blurStyle: ImgElementStyle =
    placeholder === "blur" && !blurComplete && blurDataURL
      ? {
          backgroundSize: objectFit || "cover",
          backgroundPosition: objectPosition || "0% 0%",
          filter: "blur(20px)",
          backgroundImage: `url("${blurDataURL}")`,
        }
      : {};
  if (layout === "fill") {
    // <Image src="i.png" layout="fill" />
    wrapperStyle.display = "block";
    wrapperStyle.position = "absolute";
    wrapperStyle.top = 0;
    wrapperStyle.left = 0;
    wrapperStyle.bottom = 0;
    wrapperStyle.right = 0;
  } else if (typeof widthInt !== "undefined" && typeof heightInt !== "undefined") {
    // <Image src="i.png" width="100" height="100" />
    const quotient = heightInt / widthInt;
    const paddingTop = isNaN(quotient) ? "100%" : `${quotient * 100}%`;
    if (layout === "responsive") {
      // <Image src="i.png" width="100" height="100" layout="responsive" />
      wrapperStyle.display = "block";
      wrapperStyle.position = "relative";
      hasSizer = true;
      sizerStyle.paddingTop = paddingTop;
    } else if (layout === "intrinsic") {
      // <Image src="i.png" width="100" height="100" layout="intrinsic" />
      wrapperStyle.display = "inline-block";
      wrapperStyle.position = "relative";
      wrapperStyle.maxWidth = "100%";
      hasSizer = true;
      sizerStyle.maxWidth = "100%";
      sizerSvgUrl = `data:image/svg+xml,%3csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20version=%271.1%27%20width=%27${widthInt}%27%20height=%27${heightInt}%27/%3e`;
    } else if (layout === "fixed") {
      // <Image src="i.png" width="100" height="100" layout="fixed" />
      wrapperStyle.display = "inline-block";
      wrapperStyle.position = "relative";
      wrapperStyle.width = widthInt;
      wrapperStyle.height = heightInt;
    }
  } else {
    // <Image src="i.png" />
    if (isDev) {
      throw new Error(
        `Image with src "${srcString}" must use "width" and "height" properties or "layout='fill'" property.`,
      );
    }
  }

  let imgAttributes: GenImgAttrsResult = {
    src: emptyDataURL,
    srcSet: undefined,
    sizes: undefined,
  };

  if (isVisible) {
    imgAttributes = generateImgAttrs({
      config,
      src: srcString,
      unoptimized,
      layout,
      width: widthInt,
      quality: qualityInt,
      sizes,
      loader,
    });
  }

  if (isDev) {
    if (typeof window !== "undefined") {
      let fullUrl: URL;
      try {
        fullUrl = new URL(imgAttributes.src);
      } catch {
        fullUrl = new URL(imgAttributes.src, window.location.href);
      }
      allImgs.set(fullUrl.href, { src: srcString, priority, placeholder });
    }
  }

  const onLoadingCompleteRef = useRef(onLoadingComplete);

  const previousImageSrc = useRef<string>(srcString);
  useEffect(() => {
    onLoadingCompleteRef.current = onLoadingComplete;
  }, [onLoadingComplete]);

  useNonWarningLayoutEffect(() => {
    if (previousImageSrc.current !== srcString) {
      resetIntersected();
      previousImageSrc.current = srcString;
    }
  }, [resetIntersected, srcString]);

  const imgElementArgs: ImageElementProps = {
    isLazy,
    imgAttributes,
    heightInt,
    widthInt,
    qualityInt,
    layout,
    className,
    imgStyle,
    blurStyle,
    loading,
    config,
    unoptimized,
    placeholder,
    loader,
    srcString,
    onLoadingCompleteRef,
    setBlurComplete,
    setIntersection,
    isVisible,
    noscriptSizes: sizes,
    ...rest,
  };
  return (
    <span style={wrapperStyle}>
      {hasSizer ? (
        <span style={sizerStyle}>
          {sizerSvgUrl ? (
            <img
              style={{
                display: "block",
                maxWidth: "100%",
                width: "initial",
                height: "initial",
                background: "none",
                opacity: 1,
                border: 0,
                margin: 0,
                padding: 0,
              }}
              alt=""
              aria-hidden={true}
              src={sizerSvgUrl}
            />
          ) : null}
        </span>
      ) : null}
      <ImageElement {...imgElementArgs} />
    </span>
  );
}
