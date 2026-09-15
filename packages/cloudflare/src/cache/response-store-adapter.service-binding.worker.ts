import {
  createWorkersResponseStoreClient,
  type ResponseStoreClientEntrypoint,
  type ResponseStoreRevalidatorEntrypoint,
  type WorkersResponseStoreClientEnv,
} from "@cloudflare/workers-response-store";

import {
  createVinextResponseStoreHandler,
  createVinextResponseStoreOptions,
} from "./response-store-adapter.worker.js";

const responseStore = createWorkersResponseStoreClient<WorkersResponseStoreClientEnv>(
  createVinextResponseStoreOptions(),
);

export const ResponseStoreClient: ResponseStoreClientEntrypoint =
  responseStore.entrypoints.ResponseStoreClient;
export const ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<WorkersResponseStoreClientEnv> =
  responseStore.entrypoints.ResponseStoreRevalidator;

export default createVinextResponseStoreHandler(responseStore);
