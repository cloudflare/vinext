/**
 * next/image shim.
 *
 * The implementation deliberately follows the Next.js 16 `getImgProps` shape
 * so the component and `getImageProps()` stay on the same contract.
 */

import * as React from "react";
import type { CSSProperties, JSX } from "react";
import Head from "./head.js";
import { getImageBlurSvg } from "./image-blur-svg.js";
import { ServerInsertedHTMLContext } from "./navigation.js";
import {
  hasLocalMatch,
  hasRemoteMatch,
  imageConfigDefault,
  type ImageConfigComplete,
  type ImageLoaderProps,
  type ImageLoaderPropsWithConfig,
  type LocalPattern,
  type RemotePattern,
} from "./image-config.js";

const { forwardRef } = React;

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
export type ImageLoader = (props: ImageLoaderProps) => string;
export type PlaceholderValue = "blur" | "empty" | `data:image/${string}`;
export type OnLoad = React.ReactEventHandler<HTMLImageElement> | undefined;
export type OnLoadingComplete = (img: HTMLImageElement) => void;

export type PlaceholderStyle = Partial<
  Pick<
    CSSProperties,
    "backgroundSize" | "backgroundPosition" | "backgroundRepeat" | "backgroundImage"
  >
>;

type LoadingValue = "lazy" | "eager" | undefined;
const VALID_LOADING_VALUES = ["lazy", "eager", undefined] as const;

// Object-fit values that are not valid background-size values
const INVALID_BACKGROUND_SIZE_VALUES = ["-moz-initial", "fill", "none", "scale-down", undefined];

type RuntimeImageConfig = ImageConfigComplete & {
  allSizes: number[];
};

export type ImageProps = Omit<
  JSX.IntrinsicElements["img"],
  "src" | "srcSet" | "ref" | "alt" | "width" | "height" | "loading"
> & {
  src: string | StaticImport;
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  loader?: ImageLoader;
  quality?: number | `${number}`;
  preload?: boolean;
  priority?: boolean;
  loading?: LoadingValue;
  placeholder?: PlaceholderValue;
  blurDataURL?: string;
  unoptimized?: boolean;
  overrideSrc?: string;
  onLoadingComplete?: OnLoadingComplete;
  layout?: string;
  objectFit?: string;
  objectPosition?: string;
  lazyBoundary?: string;
  lazyRoot?: string;
};

type ImgProps = Omit<ImageProps, "src" | "loader"> & {
  loading: LoadingValue;
  width: number | undefined;
  height: number | undefined;
  style: NonNullable<JSX.IntrinsicElements["img"]["style"]>;
  sizes: string | undefined;
  srcSet: string | undefined;
  src: string;
  "data-nimg": "1" | "fill";
};

type ImageMeta = {
  unoptimized: boolean;
  preload: boolean;
  placeholder: PlaceholderValue;
  fill: boolean;
};

type ImageState = {
  config?: RuntimeImageConfig;
  defaultLoader?: (props: ImageLoaderPropsWithConfig) => string;
  showAltText?: boolean;
  blurComplete?: boolean;
};

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const __imageConfig: RuntimeImageConfig = (() => {
  const deviceSizes = parseJson<number[]>(
    process.env.__VINEXT_IMAGE_DEVICE_SIZES,
    imageConfigDefault.deviceSizes,
  )
    .slice()
    .sort((a, b) => a - b);
  const imageSizes = parseJson<number[]>(
    process.env.__VINEXT_IMAGE_SIZES,
    imageConfigDefault.imageSizes,
  )
    .slice()
    .sort((a, b) => a - b);
  const allSizes = [...new Set([...deviceSizes, ...imageSizes])].sort((a, b) => a - b);
  const qualities = parseJson<number[] | undefined>(
    process.env.__VINEXT_IMAGE_QUALITIES,
    imageConfigDefault.qualities,
  )
    ?.slice()
    .sort((a, b) => a - b);

  return {
    ...imageConfigDefault,
    path: process.env.__VINEXT_IMAGE_PATH ?? imageConfigDefault.path,
    loader:
      (process.env.__VINEXT_IMAGE_LOADER as ImageConfigComplete["loader"] | undefined) ??
      imageConfigDefault.loader,
    unoptimized: process.env.__VINEXT_IMAGE_UNOPTIMIZED === "true",
    dangerouslyAllowSVG: process.env.__VINEXT_IMAGE_DANGEROUSLY_ALLOW_SVG === "true",
    domains: parseJson<string[]>(process.env.__VINEXT_IMAGE_DOMAINS, imageConfigDefault.domains),
    remotePatterns: parseJson<Array<URL | RemotePattern>>(
      process.env.__VINEXT_IMAGE_REMOTE_PATTERNS,
      imageConfigDefault.remotePatterns,
    ),
    localPatterns:
      parseJson<LocalPattern[] | null>(
        process.env.__VINEXT_IMAGE_LOCAL_PATTERNS,
        imageConfigDefault.localPatterns ?? null,
      ) ?? undefined,
    deviceSizes,
    imageSizes,
    qualities,
    allSizes,
  };
})();

function isStaticRequire(src: StaticRequire | StaticImageData): src is StaticRequire {
  return (src as StaticRequire).default !== undefined;
}

function isStaticImageData(src: StaticRequire | StaticImageData): src is StaticImageData {
  return (src as StaticImageData).src !== undefined;
}

function isStaticImport(src: string | StaticImport): src is StaticImport {
  return (
    !!src &&
    typeof src === "object" &&
    (isStaticRequire(src as StaticImport) || isStaticImageData(src as StaticImport))
  );
}

function unwrapStaticImport(src: string | StaticImport): string | StaticImageData {
  if (typeof src === "string") return src;
  return "default" in src ? src.default : src;
}

function isProtocolRelativeUrl(src: string): boolean {
  return src.startsWith("//");
}

function isAbsoluteUrl(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

function isDataUrl(src: string): boolean {
  return src.startsWith("data:");
}

function isBlobUrl(src: string): boolean {
  return src.startsWith("blob:");
}

function isRemoteLikeUrl(src: string): boolean {
  return isAbsoluteUrl(src) || isProtocolRelativeUrl(src);
}

function isLocalUrl(src: string): boolean {
  return src.startsWith("/") && !src.startsWith("//");
}

function getInt(value: unknown): number | undefined {
  if (typeof value === "undefined") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    return parseInt(value, 10);
  }
  return NaN;
}

export function findClosestQuality(quality: number, qualities?: number[]): number {
  if (!qualities?.length) return quality;
  return qualities.reduce(
    (previous, current) =>
      Math.abs(current - quality) < Math.abs(previous - quality) ? current : previous,
    qualities[0],
  );
}

function getDeploymentId(): string | undefined {
  const globalDeploymentId =
    typeof globalThis === "object" && "NEXT_DEPLOYMENT_ID" in globalThis
      ? (globalThis as Record<string, unknown>).NEXT_DEPLOYMENT_ID
      : undefined;
  return (
    (typeof globalDeploymentId === "string" ? globalDeploymentId : undefined) ||
    process.env.NEXT_DEPLOYMENT_ID ||
    undefined
  );
}

function appendDeploymentIdToSrc(src: string): string {
  if (!isLocalUrl(src)) return src;
  const deploymentId = getDeploymentId();
  if (!deploymentId) return src;

  const qIndex = src.indexOf("?");
  if (qIndex !== -1) {
    const params = new URLSearchParams(src.slice(qIndex + 1));
    if (!params.get("dpl")) {
      params.append("dpl", deploymentId);
      return `${src.slice(0, qIndex)}?${params.toString()}`;
    }
    return src;
  }
  return `${src}?dpl=${deploymentId}`;
}

function splitDeploymentId(src: string): { src: string; deploymentId?: string } {
  let deploymentId = getDeploymentId();
  if (!isLocalUrl(src)) {
    return { src, deploymentId };
  }

  const qIndex = src.indexOf("?");
  if (qIndex === -1) {
    return { src, deploymentId };
  }

  const params = new URLSearchParams(src.slice(qIndex + 1));
  const srcDeploymentId = params.get("dpl");
  if (srcDeploymentId) {
    deploymentId = srcDeploymentId;
    params.delete("dpl");
    const remaining = params.toString();
    return {
      src: src.slice(0, qIndex) + (remaining ? `?${remaining}` : ""),
      deploymentId,
    };
  }

  return { src, deploymentId };
}

function sanitizeBlurDataURL(url: string): string | undefined {
  if (!url.startsWith("data:image/")) return undefined;
  if (/[)(}{\\'"\n\r]/.test(url)) return undefined;
  return url;
}

function getWidths(
  config: RuntimeImageConfig,
  width: number | undefined,
  sizes: string | undefined,
): { widths: number[]; kind: "w" | "x" } {
  if (sizes) {
    const viewportWidthRe = /(^|\s)(1?\d?\d)vw/g;
    const percentSizes: number[] = [];
    for (let match; (match = viewportWidthRe.exec(sizes)); match) {
      percentSizes.push(parseInt(match[2], 10));
    }
    if (percentSizes.length > 0) {
      const smallestRatio = Math.min(...percentSizes) * 0.01;
      return {
        widths: config.allSizes.filter((size) => size >= config.deviceSizes[0] * smallestRatio),
        kind: "w",
      };
    }
    return { widths: config.allSizes, kind: "w" };
  }

  if (typeof width !== "number") {
    return { widths: config.deviceSizes, kind: "w" };
  }

  const widths = [
    ...new Set(
      [width, width * 2].map(
        (candidate) =>
          config.allSizes.find((possible) => possible >= candidate) ??
          config.allSizes[config.allSizes.length - 1],
      ),
    ),
  ];
  return { widths, kind: "x" };
}

function validateSrcWithConfig(
  src: string,
  config: Pick<RuntimeImageConfig, "localPatterns" | "domains" | "remotePatterns">,
): void {
  if (isProtocolRelativeUrl(src)) {
    throw new Error(
      `Failed to parse src "${src}" on \`next/image\`, protocol-relative URL (//) must be changed to an absolute URL (http:// or https://)`,
    );
  }

  if (isLocalUrl(src)) {
    if (config.localPatterns && !hasLocalMatch(config.localPatterns, src)) {
      throw new Error(
        `Invalid src prop (${src}) on \`next/image\` does not match \`images.localPatterns\` configured in your \`next.config.js\`\nSee more info: https://nextjs.org/docs/messages/next-image-unconfigured-localpatterns`,
      );
    }
    return;
  }

  if (isRemoteLikeUrl(src)) {
    const parsed = new URL(src);
    if (!hasRemoteMatch(config.domains, config.remotePatterns, parsed)) {
      throw new Error(
        `Invalid src prop (${src}) on \`next/image\`, hostname "${parsed.hostname}" is not configured under images in your \`next.config.js\`\nSee more info: https://nextjs.org/docs/messages/next-image-unconfigured-host`,
      );
    }
    return;
  }

  throw new Error(
    `Failed to parse src "${src}" on \`next/image\`, if using relative image it must start with a leading slash "/" or be an absolute URL (http:// or https://)`,
  );
}

function defaultLoader({ config, src, width, quality }: ImageLoaderPropsWithConfig): string {
  if (process.env.NODE_ENV !== "production") {
    const missingValues = [];
    if (!src) missingValues.push("src");
    if (!width) missingValues.push("width");
    if (missingValues.length > 0) {
      throw new Error(
        `Next Image Optimization requires ${missingValues.join(", ")} to be provided. Received: ${JSON.stringify(
          { src, width, quality },
        )}`,
      );
    }
    validateSrcWithConfig(src, config);
  }

  const { src: cleanSrc, deploymentId } = splitDeploymentId(src);
  const q = findClosestQuality(quality ?? 75, config.qualities);
  return `${config.path}?url=${encodeURIComponent(cleanSrc)}&w=${width}&q=${q}${
    isLocalUrl(cleanSrc) && deploymentId ? `&dpl=${deploymentId}` : ""
  }`;
}

function generateImgAttrs({
  config,
  src,
  unoptimized,
  width,
  quality,
  sizes,
  loader,
}: {
  config: RuntimeImageConfig;
  src: string;
  unoptimized: boolean;
  width?: number;
  quality?: number;
  sizes?: string;
  loader: (props: ImageLoaderPropsWithConfig) => string;
}): {
  src: string;
  srcSet: string | undefined;
  sizes: string | undefined;
} {
  if (unoptimized) {
    return {
      src: appendDeploymentIdToSrc(src),
      srcSet: undefined,
      sizes: undefined,
    };
  }

  const { widths, kind } = getWidths(config, width, sizes);
  const last = widths.length - 1;
  return {
    sizes: !sizes && kind === "w" ? "100vw" : sizes,
    srcSet: widths
      .map((resolvedWidth, index) => {
        const descriptor = kind === "w" ? `${resolvedWidth}w` : `${index + 1}x`;
        return `${loader({ config, src, width: resolvedWidth, quality })} ${descriptor}`;
      })
      .join(", "),
    src: loader({ config, src, width: widths[last], quality }),
  };
}

export function normalizeProps(
  incomingProps: ImageProps,
  state: ImageState,
): { props: ImgProps; meta: ImageMeta } {
  const {
    showAltText,
    blurComplete,
    defaultLoader: stateDefaultLoader = defaultLoader,
    config: stateConfig = __imageConfig,
  } = state;

  const {
    src: srcProp,
    alt,
    sizes: sizesProp,
    unoptimized: unoptimizedProp = false,
    priority = false,
    preload = false,
    loading,
    className,
    quality,
    width,
    height,
    fill: fillProp = false,
    style: styleProp,
    overrideSrc,
    onLoad,
    onLoadingComplete,
    placeholder = "empty",
    blurDataURL: blurDataURLProp,
    fetchPriority,
    decoding = "async",
    layout,
    objectFit,
    objectPosition,
    lazyBoundary,
    lazyRoot,
    loader: loaderProp,
    ...rest
  } = incomingProps;

  let fill = fillProp;
  let sizes = sizesProp;
  let style = styleProp;
  let blurDataURL = blurDataURLProp;

  const defaultOrCustomLoader = loaderProp
    ? ({ config: _config, ...props }: ImageLoaderPropsWithConfig) => loaderProp(props)
    : stateDefaultLoader;
  if (!loaderProp && stateConfig.loader === "custom") {
    throw new Error(
      `Image with src "${srcProp}" is missing "loader" prop.\nRead more: https://nextjs.org/docs/messages/next-image-missing-loader`,
    );
  }

  // Handle layout prop → fill, style, and sizes mapping
  if (layout) {
    if (layout === "fill") {
      fill = true;
    }
    const layoutToStyle: Record<string, Record<string, string> | undefined> = {
      intrinsic: { maxWidth: "100%", height: "auto" },
      responsive: { width: "100%", height: "auto" },
    };
    const layoutToSizes: Record<string, string | undefined> = {
      responsive: "100vw",
      fill: "100vw",
    };
    const layoutStyle = layoutToStyle[layout];
    if (layoutStyle) {
      style = { ...style, ...layoutStyle };
    }
    const layoutSizes = layoutToSizes[layout];
    if (layoutSizes && !sizes) {
      sizes = layoutSizes;
    }
  }

  let widthInt = getInt(width);
  let heightInt = getInt(height);
  let blurWidth: number | undefined;
  let blurHeight: number | undefined;

  if (isStaticImport(srcProp)) {
    const staticData = isStaticRequire(srcProp) ? srcProp.default : srcProp;
    if (!staticData.src) {
      throw new Error(
        `An object should only be passed to the image component src parameter if it comes from a static image import. It must include src. Received ${JSON.stringify(
          staticData,
        )}`,
      );
    }
    if (!staticData.width || !staticData.height) {
      throw new Error(
        `An object should only be passed to the image component src parameter if it comes from a static image import. It must include height and width. Received ${JSON.stringify(
          staticData,
        )}`,
      );
    }
    blurWidth = staticData.blurWidth;
    blurHeight = staticData.blurHeight;
    blurDataURL = blurDataURLProp ?? staticData.blurDataURL;
    if (!fill) {
      if (!widthInt && !heightInt) {
        widthInt = staticData.width;
        heightInt = staticData.height;
      } else if (widthInt && !heightInt) {
        heightInt = Math.round(staticData.height * (widthInt / staticData.width));
      } else if (!widthInt && heightInt) {
        widthInt = Math.round(staticData.width * (heightInt / staticData.height));
      }
    }
  }
  const unwrapped = unwrapStaticImport(srcProp);
  const src = typeof unwrapped === "string" ? unwrapped : unwrapped.src;

  let isLazy = !priority && !preload && (loading === "lazy" || typeof loading === "undefined");
  if (!src || isDataUrl(src) || isBlobUrl(src)) {
    isLazy = false;
  }

  if (process.env.NODE_ENV !== "production") {
    if (!src) {
      throw new Error(`Image is missing required "src" property.`);
    }
    if (fill) {
      if (width !== undefined) {
        throw new Error(
          `Image with src "${src}" has both "width" and "fill" properties. Only one should be used.`,
        );
      }
      if (height !== undefined) {
        throw new Error(
          `Image with src "${src}" has both "height" and "fill" properties. Only one should be used.`,
        );
      }
      if (style?.position && style.position !== "absolute") {
        throw new Error(
          `Image with src "${src}" has both "fill" and "style.position" properties. Images with "fill" always use position absolute - it cannot be modified.`,
        );
      }
      if (style?.width && style.width !== "100%") {
        throw new Error(
          `Image with src "${src}" has both "fill" and "style.width" properties. Images with "fill" always use width 100% - it cannot be modified.`,
        );
      }
      if (style?.height && style.height !== "100%") {
        throw new Error(
          `Image with src "${src}" has both "fill" and "style.height" properties. Images with "fill" always use height 100% - it cannot be modified.`,
        );
      }
    } else {
      if (typeof widthInt === "undefined") {
        throw new Error(`Image with src "${src}" is missing required "width" property.`);
      }
      if (isNaN(widthInt)) {
        throw new Error(
          `Image with src "${src}" has invalid "width" property. Expected a numeric value in pixels but received "${width}".`,
        );
      }
      if (typeof heightInt === "undefined") {
        throw new Error(`Image with src "${src}" is missing required "height" property.`);
      }
      if (isNaN(heightInt)) {
        throw new Error(
          `Image with src "${src}" has invalid "height" property. Expected a numeric value in pixels but received "${height}".`,
        );
      }
      if (src.length > 0 && src.charCodeAt(0) <= 0x20) {
        throw new Error(
          `Image with src "${src}" cannot start with a space or control character. Use src.trimStart() to remove it or encodeURIComponent(src) to keep it.`,
        );
      }
      if (src.length > 0 && src.charCodeAt(src.length - 1) <= 0x20) {
        throw new Error(
          `Image with src "${src}" cannot end with a space or control character. Use src.trimEnd() to remove it or encodeURIComponent(src) to keep it.`,
        );
      }
    }
    if (!VALID_LOADING_VALUES.includes(loading)) {
      throw new Error(
        `Image with src "${src}" has invalid "loading" property. Provided "${loading}" should be one of ${VALID_LOADING_VALUES.map(
          String,
        ).join(",")}.`,
      );
    }
    if (priority && loading === "lazy") {
      throw new Error(
        `Image with src "${src}" has both "priority" and "loading='lazy'" properties. Only one should be used.`,
      );
    }
    if (preload && loading === "lazy") {
      throw new Error(
        `Image with src "${src}" has both "preload" and "loading='lazy'" properties. Only one should be used.`,
      );
    }
    if (preload && priority) {
      throw new Error(
        `Image with src "${src}" has both "preload" and "priority" properties. Only "preload" should be used.`,
      );
    }
    if (
      placeholder !== "empty" &&
      placeholder !== "blur" &&
      !placeholder.startsWith("data:image/")
    ) {
      throw new Error(
        `Image with src "${src}" has invalid "placeholder" property "${placeholder}".`,
      );
    }
    if (placeholder !== "empty") {
      if (widthInt && heightInt && widthInt * heightInt < 1600) {
        console.warn(
          `Image with src "${src}" is smaller than 40x40. Consider removing the "placeholder" property to improve performance.`,
        );
      }
    }
    if (placeholder === "blur" && !blurDataURL) {
      throw new Error(
        `Image with src "${src}" has "placeholder='blur'" property but is missing the "blurDataURL" property.`,
      );
    }
    if ("ref" in rest) {
      console.warn(
        `Image with src "${src}" is using unsupported "ref" property. Consider using the "onLoad" property instead.`,
      );
    }
    if (onLoadingComplete) {
      console.warn(
        `Image with src "${src}" is using deprecated "onLoadingComplete" property. Please use "onLoad" instead.`,
      );
    }
    for (const [legacyKey, legacyValue] of Object.entries({
      layout,
      objectFit,
      objectPosition,
      lazyBoundary,
      lazyRoot,
    })) {
      if (legacyValue) {
        console.warn(`Image with src "${src}" has legacy prop "${legacyKey}".`);
      }
    }
  }

  let unoptimized = unoptimizedProp;
  if (!src || isDataUrl(src) || isBlobUrl(src)) {
    unoptimized = true;
  }
  if (stateConfig.unoptimized) {
    unoptimized = true;
  }
  if (!stateConfig.dangerouslyAllowSVG && src.split("?", 1)[0].endsWith(".svg")) {
    unoptimized = true;
  }

  const qualityInt = getInt(quality);
  if (process.env.NODE_ENV !== "production" && qualityInt && stateConfig.qualities) {
    if (!stateConfig.qualities.includes(qualityInt)) {
      console.warn(
        `Image with src "${src}" is using quality "${qualityInt}" which is not configured in images.qualities [${stateConfig.qualities.join(", ")}].`,
      );
    }
  }

  const imgAttributes = generateImgAttrs({
    config: stateConfig,
    src,
    unoptimized,
    width: widthInt,
    quality: qualityInt,
    sizes,
    loader: defaultOrCustomLoader,
  });

  const imgStyle = Object.assign(
    fill
      ? {
          position: "absolute",
          height: "100%",
          width: "100%",
          left: 0,
          top: 0,
          right: 0,
          bottom: 0,
          objectFit,
          objectPosition,
        }
      : {},
    showAltText ? {} : { color: "transparent" },
    style,
  );

  // Build placeholder style using SVG blur when placeholder='blur'
  let backgroundImage: string | null = null;
  if (!blurComplete && placeholder !== "empty") {
    if (placeholder === "blur") {
      const sanitized = sanitizeBlurDataURL(blurDataURL || "");
      if (sanitized) {
        backgroundImage = `url("data:image/svg+xml;charset=utf-8,${getImageBlurSvg({
          widthInt,
          heightInt,
          blurWidth,
          blurHeight,
          blurDataURL: sanitized,
          objectFit: imgStyle.objectFit,
        })}")`;
      }
    } else {
      const sanitized = sanitizeBlurDataURL(placeholder);
      if (sanitized) {
        backgroundImage = `url("${sanitized}")`;
      }
    }
  }

  const backgroundSize = !INVALID_BACKGROUND_SIZE_VALUES.includes(imgStyle.objectFit)
    ? imgStyle.objectFit
    : imgStyle.objectFit === "fill"
      ? "100% 100%"
      : "cover";

  const placeholderStyle: PlaceholderStyle = backgroundImage
    ? {
        backgroundSize,
        backgroundPosition: imgStyle.objectPosition || "50% 50%",
        backgroundRepeat: "no-repeat",
        backgroundImage,
      }
    : {};

  const props: ImgProps = {
    ...rest,
    alt,
    className,
    width: fill ? undefined : widthInt,
    height: fill ? undefined : heightInt,
    decoding,
    loading: isLazy ? "lazy" : loading,
    fetchPriority,
    onLoad: onLoadingComplete
      ? (e: React.SyntheticEvent<HTMLImageElement>) => {
          onLoad?.(e);
          onLoadingComplete(e.currentTarget);
        }
      : onLoad,
    style: { ...imgStyle, ...placeholderStyle },
    sizes: imgAttributes.sizes,
    srcSet: imgAttributes.srcSet,
    src: overrideSrc || imgAttributes.src,
    "data-nimg": fill ? "fill" : "1",
  };

  return {
    props,
    meta: {
      unoptimized,
      preload: preload || priority,
      placeholder,
      fill,
    },
  };
}

function cleanUndefinedProps<T extends Record<string, unknown>>(props: T): T {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) {
      delete props[key as keyof T];
    }
  }
  return props;
}

function ImagePreload({
  src,
  srcSet,
  sizes,
  crossOrigin,
  referrerPolicy,
}: {
  src: string;
  srcSet?: string;
  sizes?: string;
  crossOrigin?: string;
  referrerPolicy?: React.ImgHTMLAttributes<HTMLImageElement>["referrerPolicy"];
}) {
  const registerInsertedHTML = ServerInsertedHTMLContext
    ? React.useContext(ServerInsertedHTMLContext)
    : null;
  const linkProps = cleanUndefinedProps({
    rel: "preload",
    as: "image",
    href: src,
    imageSrcSet: srcSet,
    imageSizes: sizes,
    crossOrigin,
    referrerPolicy,
  });

  if (typeof document === "undefined" && registerInsertedHTML) {
    registerInsertedHTML(() => React.createElement("link", linkProps));
    return null;
  }

  return React.createElement(Head, null, React.createElement("link", linkProps));
}

export function imageOptimizationUrl(src: string, width: number, quality = 75): string {
  return defaultLoader({
    config: __imageConfig,
    src,
    width,
    quality,
  });
}

export function getImageProps(props: ImageProps): {
  props: React.ImgHTMLAttributes<HTMLImageElement>;
} {
  const { props: imgProps } = normalizeProps(props, {
    config: __imageConfig,
    defaultLoader,
  });
  return {
    props: cleanUndefinedProps({ ...imgProps }),
  };
}

const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(props, ref) {
  const { props: imgProps, meta } = normalizeProps(props, {
    config: __imageConfig,
    defaultLoader,
  });

  const imgElement = React.createElement("img", { ...imgProps, ref });
  if (!meta.preload) {
    return imgElement;
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(ImagePreload, {
      src: imgProps.src,
      srcSet: imgProps.srcSet,
      sizes: imgProps.sizes,
      crossOrigin: props.crossOrigin as string | undefined,
      referrerPolicy: props.referrerPolicy,
    }),
    imgElement,
  );
});

export default Image;
