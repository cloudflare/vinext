import { fileURLToPath } from "node:url";

/**
 * Preserve vinext's origin-managed ISR strategy while delegating Cloudflare
 * response-header ownership to the Cloudflare package.
 */
export function originCdnAdapter(options?: Record<string, never>) {
  return {
    adapter: fileURLToPath(import.meta.resolve("./origin-cdn-adapter.runtime.js")),
    options,
  };
}
