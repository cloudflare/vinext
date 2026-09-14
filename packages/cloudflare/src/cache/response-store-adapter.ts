import { fileURLToPath } from "node:url";
import { finalizeResponseStoreBuildOutput } from "./response-store-adapter-config.js";

const CLOUDFLARE_WORKER_ENTRY_ID = "virtual:cloudflare/worker-entry";

export type ResponseStoreAdapterOptions = {
  mode?: "self-contained" | "service-binding";
  /** Existing or desired Response Store service Worker name. */
  serviceName?: string;
  /** Existing or desired R2 bucket name for response bodies. */
  r2BucketName?: string;
  /** Set false to bind an existing compatible service without deploying it. */
  deployService?: boolean;
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
  for (const [name, value] of [
    ["serviceName", options.serviceName],
    ["r2BucketName", options.r2BucketName],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
      throw new TypeError(`responseStoreAdapter({ ${name} }) must be a non-empty string.`);
    }
  }
  if (options.deployService !== undefined && typeof options.deployService !== "boolean") {
    throw new TypeError("responseStoreAdapter({ deployService }) must be a boolean.");
  }
  if (
    mode === "self-contained" &&
    (options.serviceName !== undefined ||
      options.r2BucketName !== undefined ||
      options.deployService !== undefined)
  ) {
    throw new TypeError("Response Store service options cannot be used in self-contained mode.");
  }
  if (options.deployService === false && !options.serviceName) {
    throw new TypeError(
      "responseStoreAdapter({ deployService: false }) requires an existing serviceName.",
    );
  }
  if (options.deployService === false && options.r2BucketName) {
    throw new TypeError(
      "r2BucketName configures a deployed service and cannot be used when deployService is false.",
    );
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
        ...(mode === "service-binding"
          ? {
              finalizeBuildOutput(output: { outDir: string; isPrimaryServerOutput: boolean }) {
                return finalizeResponseStoreBuildOutput({
                  ...output,
                  serviceName: options.serviceName,
                  r2BucketName: options.r2BucketName,
                  deployService: options.deployService,
                });
              },
            }
          : {}),
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
