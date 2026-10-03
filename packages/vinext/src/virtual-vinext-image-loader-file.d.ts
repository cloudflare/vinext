/**
 * Aliased (resolve.alias, not a virtual module — there's no generated
 * content to produce, just a file swap) to the user's `images.loaderFile`
 * when next.config.js sets `images: { loader: "custom", loaderFile }`,
 * else to shims/image-loader-file-default.ts (`undefined`). See index.ts's
 * `config()` hook and shims/image.tsx.
 */
declare module "vinext:image-loader-file" {
  import type { ImageLoader } from "@vinext/types/next/upstream/dist/shared/lib/get-img-props";
  const loader: ImageLoader | undefined;
  export default loader;
}
