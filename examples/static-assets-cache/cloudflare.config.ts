import { bindings, defineConfig, defineWorker } from "@cloudflare/vite-plugin/experimental-config";

export default defineConfig({
  accountId: "d48e2eb599d9aa075d5e682deaecc518",
  worker: defineWorker({
    name: "static-assets-cache",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-04-08",
    compatibilityFlags: ["nodejs_compat"],
    previewUrls: true,
    assets: {
      notFoundHandling: "none",
      // Never serve the packaged cache entries directly, bypassing the Worker.
      runWorkerFirst: ["/_vinext/static-cache/*"],
    },
    env: { ASSETS: bindings.assets() },
    observability: { enabled: true },
  }),
});
