/**
 * Stand-in for the generated `virtual:vinext-image-loader` module.
 *
 * Tests import the `next/image` shim directly, without the vinext vite plugin,
 * so the virtual module has no resolver. This file is aliased in place of it
 * (see `WORKSPACE_SRC_ALIAS` in vite.config.ts) and mirrors what the generator
 * emits when `images.loaderFile` is not configured.
 *
 * Tests that need a configured loader should assert on
 * `generateImageLoaderModule()` output rather than trying to swap this module.
 */
export default undefined;
export const requiresLoaderProp = false;
