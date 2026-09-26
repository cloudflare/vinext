const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
const RESPONSE_STORE_ENTRYPOINT = "ResponseStoreService";
const DEFAULT_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";
const CACHE_BODIES_BINDING = "CACHE_BODIES";
const CACHE_METADATA_BINDING = "CACHE_METADATA";
const CACHE_METADATA_CLASS = "CacheMetadata";
const RESPONSE_STORE_CACHE_ENTRYPOINT = "ResponseStoreBinding";
const RESPONSE_STORE_SERVICE_ENTRYPOINT = "@cloudflare/workers-response-store/service";

type ResponseStoreStorageOptions = {
  worker: string;
  bucket: string;
};

async function createResponseStoreWorkerConfig(options: ResponseStoreStorageOptions) {
  const { bindings, exports } = await import("@cloudflare/vite-plugin/experimental-config");
  return {
    cache: { enabled: true as const },
    exports: {
      [CACHE_METADATA_CLASS]: {
        ...exports.durableObject({ storage: "sqlite" }),
        storage: "sqlite" as const,
        container: undefined,
      },
      [RESPONSE_STORE_CACHE_ENTRYPOINT]: exports.worker({ cache: { enabled: true } }),
    },
    env: {
      [CACHE_BODIES_BINDING]: bindings.r2({ name: options.bucket }),
      [CACHE_METADATA_BINDING]: {
        ...bindings.durableObject({
          worker: options.worker,
          exportName: CACHE_METADATA_CLASS,
        }),
        worker: options.worker,
        exportName: CACHE_METADATA_CLASS,
      },
    },
  };
}

export async function createWorkersResponseStoreSelfContainedConfig(
  options: ResponseStoreStorageOptions,
) {
  const { bindings } = await import("@cloudflare/vite-plugin/experimental-config");
  const storage = await createResponseStoreWorkerConfig(options);
  return {
    ...storage,
    env: {
      ...storage.env,
      [DEFAULT_VERSION_METADATA_BINDING]: bindings.versionMetadata(),
    },
  };
}

export async function createWorkersResponseStoreServiceBindingConfig(options: {
  worker: {
    name: string;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    observability?: { enabled?: boolean };
  };
  bucket: string;
}) {
  const { bindings } = await import("@cloudflare/vite-plugin/experimental-config");
  const storage = await createResponseStoreWorkerConfig({
    worker: options.worker.name,
    bucket: options.bucket,
  });
  const serviceBindingWorker = {
    ...options.worker,
    entrypoint: RESPONSE_STORE_SERVICE_ENTRYPOINT,
    workersDev: false as const,
    previewUrls: false as const,
    ...storage,
  };

  return {
    serviceBindingWorker,
    applicationWorker: {
      cache: { enabled: false as const },
      env: {
        [RESPONSE_STORE_BINDING]: bindings.worker({
          worker: serviceBindingWorker,
          exportName: RESPONSE_STORE_ENTRYPOINT,
        }),
        [DEFAULT_VERSION_METADATA_BINDING]: bindings.versionMetadata(),
      },
    },
  };
}

export async function createWorkersCacheConfig({
  versionMetadataBinding = DEFAULT_VERSION_METADATA_BINDING,
}: {
  versionMetadataBinding?: string;
} = {}) {
  if (versionMetadataBinding.length === 0) {
    throw new TypeError("versionMetadataBinding must be a non-empty string");
  }
  const { bindings, exports } = await import("@cloudflare/vite-plugin/experimental-config");
  return {
    cache: { enabled: false as const },
    env: {
      [versionMetadataBinding]: bindings.versionMetadata(),
    },
    exports: {
      VinextCachedResponse: exports.worker({ cache: { enabled: true } }),
      VinextUncachedResponse: exports.worker({ cache: { enabled: false } }),
    },
  };
}
