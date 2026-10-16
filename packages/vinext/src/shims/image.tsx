/**
 * next/image shim
 *
 * Server-safe entry, mirroring Next.js's shared/lib/image-external.tsx: the
 * Image component is a client reference ("use client" in image-component.tsx),
 * while `getImageProps` and `imageOptimizationUrl` stay callable from Server
 * Components.
 */
import type {
  ImageLoader,
  ImageProps as UpstreamImageProps,
  StaticImageData,
  StaticRequire,
} from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";

export type { ImageLoader, StaticImageData, StaticRequire };
export type ImageLoaderProps = Parameters<ImageLoader>[0];
export type ImageProps = UpstreamImageProps;

export { getImageProps, imageOptimizationUrl } from "./image-props.js";
export { default } from "./image-component.js";
