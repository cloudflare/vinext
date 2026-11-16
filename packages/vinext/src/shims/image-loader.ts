/**
 * `images.loaderFile` for next/image, kept out of the shared image modules.
 *
 * Server-safe. next/image (shims/image.tsx) and the RSC next/image entry import
 * it; next/legacy/image never does, so a legacy-only page never evaluates the
 * loader file, as in Next.js, where client/legacy/image.tsx never imports the
 * aliased `next/dist/shared/lib/image-loader` module.
 */
import type {
  ImageLoader,
  ImageProps,
  ImgProps,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
// The vinext plugin aliases this specifier to the user's `images.loaderFile`.
// A namespace import, so a file without a default export reaches the
// diagnostic in withConfiguredLoader instead of failing module linking.
import * as imageLoaderFileModule from "vinext/shims/image-loader-file";
import { __customImageLoader, buildImageProps, missingLoaderError } from "./image-props.js";

const configuredImageLoader: ImageLoader | undefined = imageLoaderFileModule.default;
/** `images.loaderFile` is set, so `configuredImageLoader` must be its default export. */
const __hasImageLoaderFile = process.env.__VINEXT_IMAGE_LOADER_FILE === "true";

/**
 * Fall back to the configured loader file when no `loader` prop is given.
 * Ported from the loader checks at the top of Next.js's getImgProps.
 */
export function withConfiguredLoader(props: ImageProps): ImageProps {
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

/**
 * getImageProps — for advanced use cases (picture elements, background images).
 * Returns the props that would be passed to the underlying <img> element.
 */
export function getImageProps(imageProps: ImageProps): { props: ImgProps } {
  return buildImageProps(withConfiguredLoader(imageProps));
}
