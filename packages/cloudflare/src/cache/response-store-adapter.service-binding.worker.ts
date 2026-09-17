import {
  createWorkersResponseStoreClient,
  type ResponseStoreClientEntrypoint,
  type ResponseStoreRevalidatorEntrypoint,
  type WorkersResponseStoreClientEnv,
} from "@cloudflare/workers-response-store";
// @ts-expect-error -- virtual module resolved by vinext at build time
import { configuredCdnCacheAdapterOptions } from "virtual:vinext-cdn-cache-adapter";

import {
  createVinextResponseStoreHandler,
  createVinextResponseStoreOptions,
} from "./response-store-adapter.worker.js";

const responseStore = createWorkersResponseStoreClient<WorkersResponseStoreClientEnv>(
  createVinextResponseStoreOptions(configuredCdnCacheAdapterOptions),
);

export const ResponseStoreClient: ResponseStoreClientEntrypoint =
  responseStore.entrypoints.ResponseStoreClient;
export const ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<WorkersResponseStoreClientEnv> =
  responseStore.entrypoints.ResponseStoreRevalidator;

export default createVinextResponseStoreHandler(responseStore);
