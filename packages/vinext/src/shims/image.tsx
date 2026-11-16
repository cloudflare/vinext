"use client";

/**
 * next/image shim
 *
 * The shared component (shims/image-base.tsx) plus `images.loaderFile`
 * (shims/image-loader.ts). next/legacy/image renders image-base.tsx directly,
 * so only next/image evaluates the loader file, as in Next.js.
 *
 * In the RSC environment, next/image resolves to a server entry that exports
 * `getImageProps` from image-loader.ts and this module's Image as a client
 * reference.
 */
import React, { forwardRef } from "react";
import type {
  ImageLoader,
  ImageProps as UpstreamImageProps,
  StaticImageData,
  StaticRequire,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
import ImageBase from "./image-base.js";
import { withConfiguredLoader } from "./image-loader.js";

export type { ImageLoader, StaticImageData, StaticRequire };
export type ImageLoaderProps = Parameters<ImageLoader>[0];
export type ImageProps = UpstreamImageProps;

export { getImageProps } from "./image-loader.js";
export { imageOptimizationUrl } from "./image-props.js";

// Annotated so declaration emit references ImageProps by name and keeps its
// @deprecated tags (https://github.com/vercel/next.js/pull/98597).
const Image: React.ForwardRefExoticComponent<ImageProps & React.RefAttributes<HTMLImageElement>> =
  forwardRef<HTMLImageElement, ImageProps>(function Image(props, ref) {
    return <ImageBase {...withConfiguredLoader(props)} ref={ref} />;
  });

export default Image;
