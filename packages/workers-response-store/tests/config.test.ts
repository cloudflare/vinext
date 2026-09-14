import assert from "node:assert/strict";

import { test } from "vitest";

import { createWorkersResponseStoreClientConfig } from "../src/config";

test("creates the user Worker side of a service-bound Response Store config", () => {
  const config = createWorkersResponseStoreClientConfig({
    worker: "example-response-store",
    bindings: {
      worker: (options) => ({ type: "worker" as const, ...options }),
      versionMetadata: () => ({ type: "version-metadata" as const }),
    },
  });

  assert.deepEqual(config, {
    cache: { enabled: false },
    env: {
      RESPONSE_STORE: {
        type: "worker",
        worker: "example-response-store",
        exportName: "ResponseStoreService",
      },
      CF_VERSION_METADATA: { type: "version-metadata" },
    },
  });
});
