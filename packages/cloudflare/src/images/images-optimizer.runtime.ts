/**
 * Cloudflare Images optimizer — backs `next/image` optimization (`/_next/image`)
 * with the Cloudflare Images binding (`env.IMAGES`) for on-the-fly resize,
 * format negotiation (AVIF/WebP/JPEG), and quality transforms at the edge.
 *
 * The default export is the optimizer factory the generated
 * `virtual:vinext-image-adapters` registration imports; configure it from
 * vite.config via the {@link imagesOptimizer} builder in `./images-optimizer.ts`
 * (which resolves this file to an absolute path). The factory reads the binding
 * from `env` at request time and throws a helpful error when it is missing — on
 * runtimes without a Cloudflare Images binding (Node.js / dev) the generated
 * registration catches the throw and falls back to unoptimized passthrough.
 */

import type { ImageOptimizer } from "vinext/server/image-optimization";

/** Default Cloudflare Images binding name on the Worker `env`. */
const DEFAULT_BINDING = "IMAGES";

/**
 * The subset of the Cloudflare Images binding API this adapter relies on.
 * @see https://developers.cloudflare.com/images/transform-images/bindings/
 */
type CloudflareImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
    };
  };
};

/** Options accepted by the optimizer factory (mirrors `ImagesOptimizerOptions`). */
type ImagesOptimizerOptions = {
  binding?: string;
};

// Config-driven optimizer factory (default export).
const createCloudflareImageOptimizer = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: ImagesOptimizerOptions;
}): ImageOptimizer => {
  const binding = options?.binding ?? DEFAULT_BINDING;
  const images = env?.[binding] as CloudflareImagesBinding | undefined;
  if (!images || typeof images.input !== "function") {
    throw new Error(
      `[vinext] The Cloudflare image optimizer requires an \`${binding}\` Images binding.\n` +
        `  Add it to wrangler.jsonc:\n` +
        `    "images": { "binding": "${binding}" }`,
    );
  }

  return {
    async transformImage(
      body: ReadableStream,
      { width, format, quality }: { width: number; format: string; quality: number },
    ) {
      // width === 0 means "no resize" (the source is served at its natural
      // size); only pass `width` to the transform when a positive value is
      // requested, matching the inline wiring vinext previously generated.
      const result = await images
        .input(body)
        .transform(width > 0 ? { width } : {})
        .output({ format, quality });
      return result.response();
    },
  };
};

export default createCloudflareImageOptimizer;
