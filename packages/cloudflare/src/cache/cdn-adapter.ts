import { fileURLToPath } from "node:url";

/**
 * Config-time builder: returns a serializable descriptor whose `adapter` is the
 * absolute path to the runtime factory. Safe to call from vite.config — it
 * never instantiates the adapter.
 */
export function cdnAdapter(options?: Record<string, never>) {
  return {
    adapter: fileURLToPath(import.meta.resolve("./cdn-adapter.runtime.js")),
    options,
  };
}
