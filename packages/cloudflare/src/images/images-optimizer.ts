import { fileURLToPath } from "node:url";

/** Options accepted by {@link imageAdapter}, forwarded to the runtime factory. */
export type ImageAdapterOptions = {
  /** Cloudflare Images binding name on the Worker `env`. @default "IMAGES" */
  binding?: string;
};

/**
 * Config-time builder: returns a serializable descriptor whose `adapter` is the
 * absolute path to the runtime factory. Safe to call from vite.config — it
 * never instantiates the optimizer or reads a binding.
 *
 * Wires `next/image` optimization (`/_next/image`) to the Cloudflare Images
 * binding for on-the-fly resize, format negotiation (AVIF/WebP), and quality
 * transforms at the edge — no custom worker entry required.
 *
 * @example
 * import { vinext } from "vinext";
 * import { imageAdapter } from "@vinext/cloudflare/images/images-optimizer";
 *
 * export default defineConfig({
 *   plugins: [vinext({ images: { optimizer: imageAdapter() } })],
 * });
 */
export function imageAdapter(options?: ImageAdapterOptions) {
  if (options?.binding !== undefined && typeof options.binding !== "string") {
    throw new TypeError("[vinext] imageAdapter({ binding }) must be a string Images binding name.");
  }
  return {
    adapter: fileURLToPath(import.meta.resolve("./images-optimizer.runtime.js")),
    options,
  };
}
