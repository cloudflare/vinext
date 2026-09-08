import { fileURLToPath } from "node:url";

const CLOUDFLARE_WORKER_ENTRY_ID = "virtual:cloudflare/worker-entry";

/**
 * Use Workers Response Store for both vinext response-stage and data caching.
 * The application Worker remains uncached; its bound cache Worker owns Workers
 * Cache, R2, SQLite metadata, and loopback regeneration.
 */
export function responseStoreAdapter() {
  const workerEntry = fileURLToPath(import.meta.resolve("./response-store-adapter.worker.js"));
  return {
    cdn: {
      adapter: fileURLToPath(import.meta.resolve("./response-store-cdn.runtime.js")),
      output: {
        entry: workerEntry,
        matchesBuild({ plugins }: { plugins: readonly { name?: string }[] }) {
          return plugins.some(
            ({ name }) =>
              name === "vite-plugin-cloudflare" || name?.startsWith("vite-plugin-cloudflare:"),
          );
        },
        transformHostEntry({ code, id }: { code: string; id: string }) {
          const cleanId = id.charCodeAt(0) === 0 ? id.slice(1) : id;
          if (cleanId !== CLOUDFLARE_WORKER_ENTRY_ID) return null;
          return `${code}\nexport { ResponseStoreClient, ResponseStoreRevalidator } from ${JSON.stringify(workerEntry)};\n`;
        },
        type: "multi-stage" as const,
      },
      capabilities: {
        buildIdentity: "response-header" as const,
        isResponsePolicyHeader: (name: string) =>
          name.toLowerCase() === "cdn-cache-control" ||
          name.toLowerCase() === "cloudflare-cdn-cache-control",
        requestRouting: "uncached-stage" as const,
        warmup: "response-store" as const,
      },
    },
    data: {
      adapter: fileURLToPath(import.meta.resolve("./response-store-data.runtime.js")),
    },
  };
}
