import { defineConfig } from "vite";
import vinext from "vinext";
import { workersCacheCdnAdapter } from "@vinext/cloudflare/cache/workers-cache-cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import type { ResponseStoreLocationHint } from "@cloudflare/workers-response-store";
import { cloudflare } from "@cloudflare/vite-plugin";

// The proxy.ts variant serves src/app, whose proxy.ts protects /dashboard.
const proxyVariant = process.env.VINEXT_RESPONSE_STORE_PROXY === "1";
const selfContained =
  proxyVariant || process.env.VINEXT_RESPONSE_STORE_MODE === "self-contained";
const cacheBackend = process.env.VINEXT_CACHE_BACKEND;
const kv = cacheBackend === "kv" || cacheBackend === "workers-cache";
const outputRoot = proxyVariant
  ? ".vinext/response-store-proxy"
  : selfContained
    ? ".vinext/response-store-self-contained"
    : "dist";
const locationHint = process.env.VINEXT_RESPONSE_STORE_LOCATION_HINT as
  | ResponseStoreLocationHint
  | undefined;

export default defineConfig({
  plugins: [
    vinext({
      ...(proxyVariant ? { appDir: "src" } : {}),
      cache: kv
        ? {
            ...(cacheBackend === "workers-cache" ? { cdn: workersCacheCdnAdapter() } : {}),
            data: kvDataAdapter({ appPrefix: process.env.VINEXT_KV_APP_PREFIX ?? cacheBackend }),
          }
        : responseStoreAdapter({
            ...(locationHint ? { locationHint } : {}),
            mode: selfContained ? "self-contained" : "service-binding",
            shards: 4,
          }),
      clientOutDir: `${outputRoot}/client`,
      rscOutDir: `${outputRoot}/server`,
      ssrOutDir: `${outputRoot}/server/ssr`,
    }),
    cloudflare({
      configPath: kv
        ? "./wrangler.kv.jsonc"
        : selfContained
          ? "./wrangler.self-contained.jsonc"
          : "./wrangler.jsonc",
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
