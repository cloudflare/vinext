/**
 * next/legacy/image shim
 *
 * Provides the pre-Next.js 13 Image component API with layout prop.
 * Translates legacy props (layout, objectFit, objectPosition) to the
 * modern Image component's fill/style props.
 *
 * This module is used by apps that ran the `next-image-to-legacy-image`
 * codemod when upgrading from Next.js 12.
 */
import React from "react";
import Image from "./image.js";
import type {
  ImageLoader,
  ImageLoaderProps,
  ImageProps,
} from "@vinext/types/next/upstream/dist/client/legacy/image";

export type { ImageLoader, ImageLoaderProps, ImageProps };

function LegacyImage(props: ImageProps): React.ReactElement {
  const {
    layout = "intrinsic",
    objectFit,
    objectPosition,
    onLoadingComplete,
    onLoad,
    alt,
    width,
    height,
    style,
    lazyRoot: _lazyRoot,
    lazyBoundary: _lazyBoundary,
    ...rest
  } = props;

  // Translate legacy props to modern Image props
  const modernStyle: React.CSSProperties = { ...style };

  if (objectFit) modernStyle.objectFit = objectFit;
  if (objectPosition) modernStyle.objectPosition = objectPosition;

  const handleLoad = onLoadingComplete
    ? (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        onLoadingComplete({
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        });
        onLoad?.(e);
      }
    : onLoad;

  if (layout === "fill") {
    return <Image alt={alt ?? ""} fill style={modernStyle} onLoad={handleLoad} {...rest} />;
  }

  if (layout === "responsive") {
    // Responsive: takes full width, maintains aspect ratio
    modernStyle.width = "100%";
    modernStyle.height = "auto";
  }

  // For "fixed" and "intrinsic", pass width/height directly
  const w = typeof width === "string" ? parseInt(width, 10) : width;
  const h = typeof height === "string" ? parseInt(height, 10) : height;

  return (
    <Image alt={alt ?? ""} width={w} height={h} style={modernStyle} onLoad={handleLoad} {...rest} />
  );
}

export default LegacyImage;
