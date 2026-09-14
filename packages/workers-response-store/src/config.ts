export const RESPONSE_STORE_BINDING = "RESPONSE_STORE";
export const RESPONSE_STORE_ENTRYPOINT = "ResponseStoreService";
export const RESPONSE_STORE_VERSION_METADATA_BINDING = "CF_VERSION_METADATA";

type ResponseStoreConfigBindings<WorkerBinding, VersionMetadataBinding> = {
  worker(options: { worker: string; exportName: typeof RESPONSE_STORE_ENTRYPOINT }): WorkerBinding;
  versionMetadata(): VersionMetadataBinding;
};

export function createWorkersResponseStoreClientConfig<
  WorkerBinding,
  VersionMetadataBinding,
>(options: {
  worker: string;
  bindings: ResponseStoreConfigBindings<WorkerBinding, VersionMetadataBinding>;
}) {
  return {
    cache: { enabled: false as const },
    env: {
      [RESPONSE_STORE_BINDING]: options.bindings.worker({
        worker: options.worker,
        exportName: RESPONSE_STORE_ENTRYPOINT,
      }),
      [RESPONSE_STORE_VERSION_METADATA_BINDING]: options.bindings.versionMetadata(),
    },
  };
}
