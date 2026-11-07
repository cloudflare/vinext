/**
 * The `images.loaderFile` slot imported by shims/image-external.tsx (next/image).
 *
 * This module exports `undefined` (no configured loader file, so the built-in
 * /_next/image loader applies). When next.config.js sets `images.loaderFile`,
 * the vinext plugin aliases `vinext/shims/image-loader-file` to that file
 * instead (see the `resolve.alias` entries in index.ts's `config()` hook),
 * mirroring how Next.js aliases `next/dist/shared/lib/image-loader` to it.
 */
import type { ImageLoader } from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";

const loader: ImageLoader | undefined = undefined;
export default loader;
