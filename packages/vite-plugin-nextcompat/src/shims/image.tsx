/**
 * next/image shim
 *
 * Translates Next.js Image props to @unpic/react Image component.
 * @unpic/react auto-detects CDN from URL and uses native transforms.
 * For local images (relative paths), falls back to a basic <img>.
 */
import React, { forwardRef } from "react";
import { Image as UnpicImage } from "@unpic/react";

interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
}

interface ImageProps {
  src: string | StaticImageData;
  alt: string;
  width?: number;
  height?: number;
  fill?: boolean;
  priority?: boolean;
  quality?: number;
  placeholder?: "blur" | "empty";
  blurDataURL?: string;
  loader?: (params: { src: string; width: number; quality?: number }) => string;
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
}

/**
 * Determine if a src is a remote URL (CDN-optimizable) or local.
 */
function isRemoteUrl(src: string): boolean {
  return src.startsWith("http://") || src.startsWith("https://") || src.startsWith("//");
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
    overrideSrc: _overrideSrc,
    loading,
    ...rest
  },
  ref,
) {
  // Handle StaticImageData (import result)
  const src = typeof srcProp === "string" ? srcProp : srcProp.src;
  const imgWidth = width ?? (typeof srcProp === "object" ? srcProp.width : undefined);
  const imgHeight = height ?? (typeof srcProp === "object" ? srcProp.height : undefined);
  const imgBlurDataURL = blurDataURL ?? (typeof srcProp === "object" ? srcProp.blurDataURL : undefined);

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
            ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style }
            : style
        }
        {...rest}
      />
    );
  }

  // For remote URLs, use @unpic/react which auto-detects CDN
  if (isRemoteUrl(src)) {
    const bg =
      placeholder === "blur" && imgBlurDataURL
        ? `url(${imgBlurDataURL})`
        : undefined;

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

  // For local images, render a standard <img> tag.
  // In production, vite-imagetools would optimize these at build time.
  return (
    <img
      ref={ref}
      src={src}
      alt={alt}
      width={fill ? undefined : imgWidth}
      height={fill ? undefined : imgHeight}
      loading={priority ? "eager" : (loading ?? "lazy")}
      decoding="async"
      sizes={sizes}
      className={className}
      style={
        fill
          ? { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", ...style }
          : style
      }
      {...rest}
    />
  );
});

export default Image;
