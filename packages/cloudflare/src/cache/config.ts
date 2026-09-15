const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
const RESPONSE_STORE_ENTRYPOINT = "ResponseStoreService";
const DEFAULT_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";
const CACHE_BODIES_BINDING = "CACHE_BODIES";
const CACHE_METADATA_BINDING = "CACHE_METADATA";
const CACHE_METADATA_CLASS = "CacheMetadata";
const RESPONSE_STORE_CACHE_ENTRYPOINT = "ResponseStoreBinding";
const RESPONSE_STORE_SERVICE_ENTRYPOINT = "@cloudflare/workers-response-store/service";

type WorkerExportFactory<WorkerExport> = {
  worker(options: { cache: { enabled: boolean } }): WorkerExport;
};

type ServiceBindingWorkerConfig<
  R2Binding,
  DurableObjectBinding,
  WorkerExport,
  DurableObjectExport,
> = {
  type: "worker";
  name: string;
  entrypoint: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
  observability?: { enabled?: boolean };
  workersDev: false;
  previewUrls: false;
  cache: { enabled: true };
  exports: {
    default: WorkerExport;
    CacheMetadata: DurableObjectExport;
    ResponseStoreBinding: WorkerExport;
  };
  env: {
    CACHE_BODIES: R2Binding;
    CACHE_METADATA: DurableObjectBinding;
  };
};

type ResponseStoreConfigBindings<
  WorkerBinding,
  R2Binding,
  DurableObjectBinding,
  VersionMetadataBinding,
  WorkerExport,
  DurableObjectExport,
> = {
  worker(options: {
    worker: ServiceBindingWorkerConfig<
      R2Binding,
      DurableObjectBinding,
      WorkerExport,
      DurableObjectExport
    >;
    exportName: typeof RESPONSE_STORE_ENTRYPOINT;
  }): WorkerBinding;
  r2(options: { name: string }): R2Binding;
  durableObject(options: {
    worker: string;
    exportName: typeof CACHE_METADATA_CLASS;
  }): DurableObjectBinding;
  versionMetadata(): VersionMetadataBinding;
};

type ResponseStoreConfigExports<WorkerExport, DurableObjectExport> =
  WorkerExportFactory<WorkerExport> & {
    durableObject(options: { storage: "sqlite" }): DurableObjectExport;
  };

type ResponseStoreStorageOptions<
  R2Binding,
  DurableObjectBinding,
  VersionMetadataBinding,
  WorkerExport,
  DurableObjectExport,
> = {
  worker: string;
  bucket: string;
  bindings: Pick<
    ResponseStoreConfigBindings<
      never,
      R2Binding,
      DurableObjectBinding,
      VersionMetadataBinding,
      WorkerExport,
      DurableObjectExport
    >,
    "r2" | "durableObject" | "versionMetadata"
  >;
  exports: ResponseStoreConfigExports<WorkerExport, DurableObjectExport>;
};

function createResponseStoreWorkerConfig<
  R2Binding,
  DurableObjectBinding,
  VersionMetadataBinding,
  WorkerExport,
  DurableObjectExport,
>(
  options: ResponseStoreStorageOptions<
    R2Binding,
    DurableObjectBinding,
    VersionMetadataBinding,
    WorkerExport,
    DurableObjectExport
  >,
) {
  return {
    cache: { enabled: true as const },
    exports: {
      default: options.exports.worker({ cache: { enabled: false } }),
      [CACHE_METADATA_CLASS]: options.exports.durableObject({ storage: "sqlite" }),
      [RESPONSE_STORE_CACHE_ENTRYPOINT]: options.exports.worker({ cache: { enabled: true } }),
    },
    env: {
      [CACHE_BODIES_BINDING]: options.bindings.r2({ name: options.bucket }),
      [CACHE_METADATA_BINDING]: options.bindings.durableObject({
        worker: options.worker,
        exportName: CACHE_METADATA_CLASS,
      }),
    },
  };
}

export function createWorkersResponseStoreSelfContainedConfig<
  R2Binding,
  DurableObjectBinding,
  VersionMetadataBinding,
  WorkerExport,
  DurableObjectExport,
>(
  options: ResponseStoreStorageOptions<
    R2Binding,
    DurableObjectBinding,
    VersionMetadataBinding,
    WorkerExport,
    DurableObjectExport
  >,
) {
  const storage = createResponseStoreWorkerConfig(options);
  return {
    ...storage,
    env: {
      ...storage.env,
      [DEFAULT_VERSION_METADATA_BINDING]: options.bindings.versionMetadata(),
    },
  };
}

export function createWorkersResponseStoreServiceBindingConfig<
  WorkerBinding,
  R2Binding,
  DurableObjectBinding,
  VersionMetadataBinding,
  WorkerExport,
  DurableObjectExport,
>(options: {
  worker: {
    name: string;
    compatibilityDate: string;
    compatibilityFlags?: string[];
    observability?: { enabled?: boolean };
  };
  bucket: string;
  bindings: ResponseStoreConfigBindings<
    WorkerBinding,
    R2Binding,
    DurableObjectBinding,
    VersionMetadataBinding,
    WorkerExport,
    DurableObjectExport
  >;
  exports: ResponseStoreConfigExports<WorkerExport, DurableObjectExport>;
}) {
  const storage = createResponseStoreWorkerConfig({
    worker: options.worker.name,
    bucket: options.bucket,
    bindings: options.bindings,
    exports: options.exports,
  });
  const serviceBindingWorker = {
    type: "worker" as const,
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
        [RESPONSE_STORE_BINDING]: options.bindings.worker({
          worker: serviceBindingWorker,
          exportName: RESPONSE_STORE_ENTRYPOINT,
        }),
        [DEFAULT_VERSION_METADATA_BINDING]: options.bindings.versionMetadata(),
      },
    },
  };
}

export function createWorkersCacheConfig<VersionMetadataBinding, WorkerExport>({
  bindings,
  exports,
  versionMetadataBinding = DEFAULT_VERSION_METADATA_BINDING,
}: {
  bindings: { versionMetadata(): VersionMetadataBinding };
  exports: WorkerExportFactory<WorkerExport>;
  versionMetadataBinding?: string;
}) {
  if (versionMetadataBinding.length === 0) {
    throw new TypeError("versionMetadataBinding must be a non-empty string");
  }
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
