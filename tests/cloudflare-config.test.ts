import { describe, expect, it } from "vite-plus/test";

import {
  createWorkersCacheConfig,
  createWorkersResponseStoreSelfContainedConfig,
  createWorkersResponseStoreServiceBindingConfig,
} from "../packages/cloudflare/src/cache/config.js";

const bindings = {
  worker: (options: object) => ({ type: "worker" as const, ...options }),
  r2: (options: object) => ({ type: "r2" as const, ...options }),
  durableObject: (options: object) => ({ type: "durable-object" as const, ...options }),
  versionMetadata: () => ({ type: "version-metadata" as const }),
};
const workerExports = {
  worker: (options: object) => ({ type: "worker" as const, ...options }),
  durableObject: (options: object) => ({ type: "durable-object" as const, ...options }),
};

describe("typed Cloudflare cache config", () => {
  it("creates Workers Cache bindings and exports", () => {
    expect(createWorkersCacheConfig({ bindings, exports: workerExports })).toEqual({
      cache: { enabled: false },
      env: {
        CF_VERSION_METADATA: { type: "version-metadata" },
      },
      exports: {
        VinextCachedResponse: { type: "worker", cache: { enabled: true } },
        VinextUncachedResponse: { type: "worker", cache: { enabled: false } },
      },
    });
  });

  it("supports a custom Workers Cache version metadata binding", () => {
    expect(
      createWorkersCacheConfig({
        bindings,
        exports: workerExports,
        versionMetadataBinding: "CUSTOM_VERSION",
      }).env,
    ).toEqual({ CUSTOM_VERSION: { type: "version-metadata" } });
    expect(() =>
      createWorkersCacheConfig({
        bindings,
        exports: workerExports,
        versionMetadataBinding: "",
      }),
    ).toThrow("versionMetadataBinding must be a non-empty string");
  });

  it("creates self-contained Workers Response Store config", () => {
    expect(
      createWorkersResponseStoreSelfContainedConfig({
        worker: "example",
        bucket: "example-cache-bodies",
        bindings,
        exports: workerExports,
      }),
    ).toEqual({
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

  it("creates service-binding Workers Response Store config", () => {
    const config = createWorkersResponseStoreServiceBindingConfig({
      worker: {
        name: "example-response-store",
        compatibilityDate: "2026-09-14",
        compatibilityFlags: ["nodejs_compat"],
        observability: { enabled: true },
      },
      bucket: "example-cache-bodies",
      bindings,
      exports: workerExports,
    });

    expect(config).toEqual({
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
});
