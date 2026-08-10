/**
 * Code generation for the `virtual:vinext-image-loader` module, resolved by the
 * vinext vite plugin from `images.loaderFile` in next.config.
 *
 * Next.js implements `loaderFile` as a bundler alias: the module that
 * `next/image` imports for its default loader
 * (`next/dist/shared/lib/image-loader`) is swapped for the user's file — see
 * `create-compiler-aliases.ts` upstream. vinext replaces `next/image` wholesale
 * with its own shim, so there is no upstream module left to alias. Instead the
 * shim imports this virtual module unconditionally and the plugin generates
 * either a re-export of the user's loader or an inert stub.
 *
 * Every branch emits the same two exports so the shim's unconditional import
 * stays valid whether or not `loaderFile` is configured: `default` is the loader
 * (or `undefined`), and `requiresLoaderProp` says whether the configuration
 * demands that each `<Image>` bring its own `loader` prop.
 *
 * This mirrors the adapter pattern in `image/image-adapters-virtual.ts`.
 */

/** Public virtual module id imported by the `next/image` shim. */
export const VIRTUAL_IMAGE_LOADER = "virtual:vinext-image-loader";

/**
 * Next.js's error for a `loaderFile` whose module has no default export.
 * Kept verbatim so existing troubleshooting docs and searches still apply.
 */
const MISSING_DEFAULT_EXPORT_ERROR =
  "images.loaderFile detected but the file is missing default export.\n" +
  "Read more: https://nextjs.org/docs/messages/invalid-images-config";

/**
 * Generate the source of the `virtual:vinext-image-loader` module.
 *
 * @param images The resolved `images` block from next.config. `loaderFile` is
 *   expected to already be an absolute path (see `resolveImageLoaderFile`).
 */
export function generateImageLoaderModule(images?: {
  loader?: "default" | "custom";
  loaderFile?: string;
}): string {
  const loaderFile = images?.loaderFile;

  // `loader: "custom"` with no `loaderFile` means every image must supply its
  // own `loader` prop. Export a loader that reports the omission instead of
  // silently falling back to `/_next/image`, matching upstream's `customLoader`.
  if (!loaderFile && images?.loader === "custom") {
    return [
      '// vinext: images.loader is "custom" with no images.loaderFile — each',
      "// <Image> must pass its own `loader` prop.",
      "export default function customImageLoader({ src }) {",
      "  throw new Error(",
      "    'Image with src \"' + src + '\" is missing \"loader\" prop.\\n' +",
      "      'Read more: https://nextjs.org/docs/messages/next-image-missing-loader',",
      "  );",
      "}",
      "",
      "// Tells the shim the default export reports a misconfiguration rather than",
      "// generating URLs — see image/image-loader-virtual.ts.",
      "export const requiresLoaderProp = true;",
      "",
    ].join("\n");
  }

  // Nothing configured → the shim falls back to its built-in `/_next/image`
  // loader. `undefined` (not `null`) so the shim's `??` fallback reads naturally.
  if (!loaderFile) {
    return [
      "// vinext: no images.loaderFile configured — the built-in /_next/image loader is used.",
      "export default undefined;",
      "export const requiresLoaderProp = false;",
      "",
    ].join("\n");
  }

  return [
    "// vinext: generated from `images.loaderFile` in your next.config.",
    `import * as __vinextUserImageLoaderModule from ${JSON.stringify(loaderFile)};`,
    "",
    "const __vinextImageLoader = __vinextUserImageLoaderModule.default;",
    "",
    "// Configuring loaderFile is an explicit opt-in, so a module that cannot",
    "// supply a loader is a config error worth failing on immediately rather",
    "// than silently falling back to the built-in optimizer — which would be",
    "// indistinguishable from the loaderFile being ignored.",
    "if (typeof __vinextImageLoader !== 'function') {",
    `  throw new Error(${JSON.stringify(MISSING_DEFAULT_EXPORT_ERROR)});`,
    "}",
    "",
    "export default __vinextImageLoader;",
    "export const requiresLoaderProp = false;",
    "",
  ].join("\n");
}
