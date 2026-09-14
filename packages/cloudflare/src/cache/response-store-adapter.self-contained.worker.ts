import {
  createSelfContainedWorkersResponseStore,
  type ResponseStoreRevalidatorEntrypoint,
  type WorkersResponseStoreEnv,
} from "@cloudflare/workers-response-store";
import type {
  CacheMetadata as CacheMetadataClass,
  ResponseStoreBinding as ResponseStoreBindingClass,
} from "@cloudflare/workers-response-store/service";

import {
  createVinextResponseStoreHandler,
  createVinextResponseStoreOptions,
} from "./response-store-adapter.worker.js";

const responseStore = createSelfContainedWorkersResponseStore<WorkersResponseStoreEnv>(
  createVinextResponseStoreOptions(),
);

export const CacheMetadata: typeof CacheMetadataClass = responseStore.entrypoints.CacheMetadata;
export const ResponseStoreBinding: typeof ResponseStoreBindingClass =
  responseStore.entrypoints.ResponseStoreBinding;
export const ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<WorkersResponseStoreEnv> =
  responseStore.entrypoints.ResponseStoreRevalidator;

export default createVinextResponseStoreHandler(responseStore);
