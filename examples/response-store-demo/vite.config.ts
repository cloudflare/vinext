import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

const selfContained = process.env.VINEXT_RESPONSE_STORE_MODE === "self-contained";
const kv = process.env.VINEXT_CACHE_BACKEND === "kv";
const outputRoot = selfContained ? ".vinext/response-store-self-contained" : "dist";

export default defineConfig({
  plugins: [
    vinext({
      cache: kv
        ? {
            cdn: cdnAdapter(),
            data: kvDataAdapter({ appPrefix: process.env.VINEXT_KV_APP_PREFIX ?? "workers-cache" }),
          }
        : responseStoreAdapter({
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
