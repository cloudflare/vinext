import { getDeploymentId } from "../utils/deployment-id.js";

export type ImageLoaderProps = {
  src: string;
  width: number;
  quality?: number;
};

const imagePath = process.env.__VINEXT_IMAGE_PATH ?? "/_next/image";

const configuredImageLoader = Object.assign(
  ({ src, width, quality }: ImageLoaderProps): string => {
    if ((process.env.__VINEXT_IMAGE_LOADER ?? "default") === "custom") {
      throw new Error(
        `Image with src "${src}" is missing "loader" prop.\nRead more: https://nextjs.org/docs/messages/next-image-missing-loader`,
      );
    }
    const deploymentId = src.startsWith("/") ? getDeploymentId() : undefined;
    return `${imagePath}?url=${encodeURIComponent(src)}&w=${width}&q=${quality ?? 75}${deploymentId ? `&dpl=${deploymentId}` : ""}`;
  },
  process.env.__VINEXT_IMAGE_LOADER_FILE === "true" ||
    (process.env.__VINEXT_IMAGE_LOADER ?? "default") === "custom"
    ? {}
    : { __next_img_default: true },
);

export default configuredImageLoader;
