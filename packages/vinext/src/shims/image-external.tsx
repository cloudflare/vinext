"use client";

/**
 * next/image entry: the shared shim in ./image.tsx plus `images.loaderFile`.
 *
 * Mirrors Next.js, where next/image (shared/lib/image-external.tsx) imports
 * the default image-loader module that `images.loaderFile` is aliased over,
 * while next/legacy/image never imports it. shims/legacy-image.tsx imports
 * ./image.tsx directly, so legacy-only pages never evaluate the loader file.
 */
import { forwardRef } from "react";
// The vinext plugin aliases this specifier to the user's `images.loaderFile`.
// A namespace import, so a file without a default export reaches the
// diagnostic below instead of failing module linking.
import * as imageLoaderFileModule from "vinext/shims/image-loader-file";
import ImageWithoutLoaderFile, {
  getImageProps as getImagePropsWithoutLoaderFile,
  missingLoaderError,
  type ImageLoader,
  type ImageProps,
} from "./image.js";

export type {
  ImageLoader,
  ImageLoaderProps,
  ImageProps,
  StaticImageData,
  StaticRequire,
} from "./image.js";

const configuredImageLoader: ImageLoader | undefined = imageLoaderFileModule.default;
/** `images.loaderFile` is set, so `configuredImageLoader` must be its default export. */
const __hasImageLoaderFile = process.env.__VINEXT_IMAGE_LOADER_FILE === "true";
/** `images.loader: "custom"`: images need a loader prop or `images.loaderFile`. */
const __customImageLoader = process.env.__VINEXT_IMAGE_CUSTOM_LOADER === "true";

/** Ported from the loader checks at the top of Next.js's getImgProps. */
function withConfiguredLoader(props: ImageProps): ImageProps {
  if (__hasImageLoaderFile && typeof configuredImageLoader === "undefined") {
    throw new Error(
      "images.loaderFile detected but the file is missing default export.\nRead more: https://nextjs.org/docs/messages/invalid-images-config",
    );
  }
  const loader = props.loader || configuredImageLoader;
  if (!loader && __customImageLoader) {
    const { src } = props;
    throw missingLoaderError(
      typeof src === "string" ? src : ("default" in src ? src.default : src).src,
    );
  }
  return loader === props.loader ? props : { ...props, loader };
}

const ImageWithLoaderFile = forwardRef<HTMLImageElement, ImageProps>(function Image(props, ref) {
  return <ImageWithoutLoaderFile {...withConfiguredLoader(props)} ref={ref} />;
});

export function getImageProps(
  props: ImageProps,
): ReturnType<typeof getImagePropsWithoutLoaderFile> {
  return getImagePropsWithoutLoaderFile(withConfiguredLoader(props));
}

export default ImageWithLoaderFile;
