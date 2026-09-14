import { fileURLToPath } from "node:url";

const CLOUDFLARE_WORKER_ENTRY_ID = "virtual:cloudflare/worker-entry";

export type ResponseStoreAdapterOptions = {
  mode?: "self-contained" | "service-binding";
};

/**
 * Use Workers Response Store for both vinext response-stage and data caching.
 * Service-binding mode keeps storage in a separate cache Worker. Self-contained
 * mode keeps the same API and loopback in the application Worker.
 */
export function responseStoreAdapter(options: ResponseStoreAdapterOptions = {}) {
  const mode = options.mode ?? "service-binding";
  if (mode !== "service-binding" && mode !== "self-contained") {
    throw new Error(`Unknown Workers Response Store mode: ${String(mode)}`);
  }
  const workerEntry = fileURLToPath(
    import.meta.resolve(
      mode === "self-contained"
        ? "./response-store-adapter.self-contained.worker.js"
        : "./response-store-adapter.service-binding.worker.js",
    ),
  );
  const entrypoints =
    mode === "self-contained"
      ? "CacheMetadata, ResponseStoreBinding, ResponseStoreRevalidator"
      : "ResponseStoreClient, ResponseStoreRevalidator";
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
          return `${code}\nexport { ${entrypoints} } from ${JSON.stringify(workerEntry)};\n`;
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
