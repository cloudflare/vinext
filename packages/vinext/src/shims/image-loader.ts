/**
 * The `images.loaderFile` slot of next/image.
 *
 * Next.js aliases `next/dist/shared/lib/image-loader` to the configured
 * `images.loaderFile`, so that file's default export replaces the built-in
 * loader (packages/next/src/build/create-compiler-aliases.ts). vinext aliases
 * `private-next-image-loader`, which the image shim imports, to the file in
 * the same way (see `nextShimMap` in index.ts). This module is what loads when
 * no loader file is configured: it has no default export, and the image shim
 * then uses vinext's default loader.
 */
export {};
