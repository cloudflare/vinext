/**
 * Default resolution target for the `vinext:image-loader-file` alias.
 *
 * The vinext plugin aliases that bare specifier to the user's configured
 * `images.loaderFile` (resolved to an absolute path) when next.config.js
 * sets `images: { loader: "custom", loaderFile: "..." }` — see the
 * `resolve.alias` entries built in index.ts's `config()` hook. When no
 * `loaderFile` is configured, the alias points here instead, so
 * `shims/image.tsx`'s `import __imageLoaderFileDefault from
 * "vinext:image-loader-file"` always resolves to something: a real custom
 * loader, or `undefined` (a no-op — the shim falls back to the built-in
 * /_next/image loader).
 */
import type { ImageLoader } from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";

const loader: ImageLoader | undefined = undefined;
export default loader;
