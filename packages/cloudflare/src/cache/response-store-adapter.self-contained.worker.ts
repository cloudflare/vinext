import "vinext/internal/server/cloudflare-workers-tracing";
import {
  createWorkersResponseStore,
  type ResponseStoreRevalidatorEntrypoint,
  type WorkersResponseStoreEnv,
} from "@cloudflare/workers-response-store";
import type {
  CacheMetadata as CacheMetadataClass,
  ResponseStoreBinding as ResponseStoreBindingClass,
} from "@cloudflare/workers-response-store/service";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { configuredCdnCacheAdapterOptions } from "virtual:vinext-cdn-cache-adapter";

import {
  createVinextResponseStoreHandler,
  createVinextResponseStoreOptions,
} from "./response-store-adapter.worker.js";

const responseStore = createWorkersResponseStore<WorkersResponseStoreEnv>(
  createVinextResponseStoreOptions(configuredCdnCacheAdapterOptions),
);

export const CacheMetadata: typeof CacheMetadataClass = responseStore.entrypoints.CacheMetadata;
export const ResponseStoreBinding: typeof ResponseStoreBindingClass =
  responseStore.entrypoints.ResponseStoreBinding;
export const ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<WorkersResponseStoreEnv> =
  responseStore.entrypoints.ResponseStoreRevalidator;

export default createVinextResponseStoreHandler(responseStore);
