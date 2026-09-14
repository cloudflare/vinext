import assert from "node:assert/strict";

import { test } from "vitest";

import {
  createSelfContainedWorkersResponseStoreConfig,
  createServiceBindingWorkersResponseStoreConfig,
} from "../src/config";

const bindings = {
  worker: (options: object) => ({ type: "worker" as const, ...options }),
  r2: (options: object) => ({ type: "r2" as const, ...options }),
  durableObject: (options: object) => ({ type: "durable-object" as const, ...options }),
  versionMetadata: () => ({ type: "version-metadata" as const }),
};
const exports = {
  worker: (options: object) => ({ type: "worker" as const, ...options }),
  durableObject: (options: object) => ({ type: "durable-object" as const, ...options }),
};

test("creates self-contained Response Store bindings and exports", () => {
  const config = createSelfContainedWorkersResponseStoreConfig({
    worker: "example",
    bucket: "example-cache-bodies",
    bindings,
    exports,
  });

  assert.deepEqual(config, {
    cache: { enabled: true },
    exports: {
      default: { type: "worker", cache: { enabled: false } },
      CacheMetadata: { type: "durable-object", storage: "sqlite" },
      ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
    },
    env: {
      CACHE_BODIES: { type: "r2", name: "example-cache-bodies" },
      CACHE_METADATA: {
        type: "durable-object",
        worker: "example",
        exportName: "CacheMetadata",
      },
      CF_VERSION_METADATA: { type: "version-metadata" },
    },
  });
});

test("creates both Workers for service-binding mode", () => {
  const config = createServiceBindingWorkersResponseStoreConfig({
    worker: {
      name: "example-response-store",
      compatibilityDate: "2026-09-14",
      compatibilityFlags: ["nodejs_compat"],
      observability: { enabled: true },
    },
    bucket: "example-cache-bodies",
    bindings,
    exports,
  });

  assert.deepEqual(config, {
    serviceBindingWorker: {
      type: "worker",
      name: "example-response-store",
      entrypoint: "@cloudflare/workers-response-store/service",
      compatibilityDate: "2026-09-14",
      compatibilityFlags: ["nodejs_compat"],
      observability: { enabled: true },
      workersDev: false,
      previewUrls: false,
      cache: { enabled: true },
      exports: {
        default: { type: "worker", cache: { enabled: false } },
        CacheMetadata: { type: "durable-object", storage: "sqlite" },
        ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
      },
      env: {
        CACHE_BODIES: { type: "r2", name: "example-cache-bodies" },
        CACHE_METADATA: {
          type: "durable-object",
          worker: "example-response-store",
          exportName: "CacheMetadata",
        },
      },
    },
    applicationWorker: {
      cache: { enabled: false },
      env: {
        RESPONSE_STORE: {
          type: "worker",
          worker: config.serviceBindingWorker,
          exportName: "ResponseStoreService",
        },
        CF_VERSION_METADATA: { type: "version-metadata" },
      },
    },
  });
});
