import type { ImageLoaderProps } from "next/image";

/**
 * Custom next/image loader targeting the media proxy directly. Because every
 * <Image> in the app supplies this loader, the framework's own
 * `/_next/image` endpoint is never used — which is why the middleware can
 * hard-403 it.
 */
export const mediaProxyLoader = ({
  src,
  width,
  quality,
}: ImageLoaderProps): string =>
  `https://media.atlas-fixture.test/imgproxy/w_${width},q_${quality ?? 75}/${encodeURIComponent(src)}`;
