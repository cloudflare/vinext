import {
  bindings,
  defineSettings,
  defineWorker,
  exports as workerExports,
  triggers,
} from "@cloudflare/vite-plugin/experimental-config";

export const settings = defineSettings({
  accountId: "d48e2eb599d9aa075d5e682deaecc518",
});

export default defineWorker({
  name: "vinext-web",
  entrypoint: "./worker/index.ts",
  compatibilityDate: "2026-04-08",
  compatibilityFlags: ["nodejs_compat"],
  previewUrls: true,
  assets: { notFoundHandling: "none" },
  env: {
    ASSETS: bindings.assets(),
    IMAGES: bindings.images(),
    DB: bindings.d1({
      id: "63e7cd24-9d47-4f17-a41d-b5806babc406",
      name: "vinext-metrics",
    }),
    VINEXT_KV_CACHE: bindings.kv({
      id: "08075d24ec854a19a52c13f031723def",
    }),
    PERFORMANCE_PROFILES: bindings.r2({
      name: "vinext-performance-profiles",
    }),
    COMPAT_INGEST_SECRET: bindings.secret(),
    CF_VERSION_METADATA: bindings.versionMetadata(),
  },
  triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
  cache: { enabled: false },
  exports: {
    VinextCachedResponse: workerExports.worker({ cache: { enabled: true } }),
    VinextUncachedResponse: workerExports.worker({ cache: { enabled: false } }),
  },
  observability: {
    enabled: true,
    headSamplingRate: 1,
    logs: { enabled: true, invocationLogs: true },
    traces: { enabled: true },
  },
});
