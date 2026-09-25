import {
  bindings,
  defineConfig,
  defineWorker,
  exports,
  triggers,
} from "@cloudflare/vite-plugin/experimental-config";
import { createWorkersResponseStoreServiceBindingConfig } from "@vinext/cloudflare/cache/config";

const responseStoreWorkerName =
  process.env.VINEXT_RESPONSE_STORE_WORKER_NAME || "vinext-web-response-store";
const responseStore = createWorkersResponseStoreServiceBindingConfig({
  worker: {
    name: responseStoreWorkerName,
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true },
  },
  bucket: "vinext-web-response-store-cache-bodies",
  bindings,
  exports,
});

export const responseStoreServiceBinding = responseStore.serviceBindingWorker;

export default defineConfig({
  accountId: "d48e2eb599d9aa075d5e682deaecc518",
  worker: defineWorker({
    ...responseStore.applicationWorker,
    name: "vinext-web",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat"],
    previewUrls: true,
    assets: { notFoundHandling: "none" },
    env: {
      ...responseStore.applicationWorker.env,
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
    },
    triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, invocationLogs: true },
      traces: { enabled: true },
    },
  }),
});
