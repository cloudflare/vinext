import { fileURLToPath } from "node:url";

import type { ResponseStoreLocationHint } from "@cloudflare/workers-response-store";

const CLOUDFLARE_WORKER_ENTRY_ID = "virtual:cloudflare/worker-entry";
const RESPONSE_STORE_LOCATION_HINTS = {
  afr: true,
  apac: true,
  "apac-ne": true,
  "apac-se": true,
  eeur: true,
  enam: true,
  me: true,
  oc: true,
  sam: true,
  weur: true,
  wnam: true,
} satisfies Record<ResponseStoreLocationHint, true>;

export type ResponseStoreAdapterOptions = {
  /**
   * Best-effort location for metadata Durable Objects on first creation.
   * Changing this does not move existing objects and should be treated as a
   * cache-cold deployment change.
   */
  locationHint?: ResponseStoreLocationHint;
  mode?: "self-contained" | "service-binding";
  /** Split version-scoped metadata across this many Durable Objects. */
  shards?: number;
};

/**
 * Use Workers Response Store for both vinext response-stage and data caching.
 * Service-binding mode keeps storage in a separate cache Worker. Self-contained
 * mode keeps the same API and loopback in the application Worker.
 */
export function responseStoreAdapter(options: ResponseStoreAdapterOptions = {}) {
  const locationHint = options.locationHint;
  if (locationHint !== undefined && !Object.hasOwn(RESPONSE_STORE_LOCATION_HINTS, locationHint)) {
    throw new TypeError("Workers Response Store locationHint is not supported by Cloudflare");
  }
  const mode = options.mode ?? "service-binding";
  if (mode !== "service-binding" && mode !== "self-contained") {
    throw new Error(`Unknown Workers Response Store mode: ${String(mode)}`);
  }
  if (
    options.shards !== undefined &&
    (!Number.isSafeInteger(options.shards) || options.shards <= 1)
  ) {
    throw new TypeError("Workers Response Store shards must be an integer greater than 1");
  }
  const configuredOptions = {
    ...(locationHint === undefined ? {} : { locationHint }),
    ...(options.shards === undefined ? {} : { shards: options.shards }),
  };
  const runtimeOptions =
    Object.keys(configuredOptions).length === 0 ? {} : { options: configuredOptions };
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
      ...runtimeOptions,
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
      ...runtimeOptions,
    },
  };
}
