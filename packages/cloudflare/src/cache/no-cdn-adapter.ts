import { fileURLToPath } from "node:url";

export function noCdnCacheAdapter(options?: Record<string, never>) {
  return {
    adapter: fileURLToPath(import.meta.resolve("./no-cdn-adapter.runtime.js")),
    options,
  };
}
