import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { workersCacheCdnAdapter } from "../../../packages/cloudflare/src/cache/workers-cache-cdn-adapter";
import { responseStoreAdapter } from "../../../packages/cloudflare/src/cache/response-store-adapter";

const workersCache = process.env.VINEXT_SENTRY_CACHE === "workers";
const outputRoot = workersCache ? ".vinext/workers-cache" : "dist";

export default defineConfig({
  plugins: [
    vinext({
      cache: workersCache
        ? workersCacheCdnAdapter()
        : responseStoreAdapter({ mode: "self-contained" }),
      clientOutDir: `${outputRoot}/client`,
      rscOutDir: `${outputRoot}/server`,
      ssrOutDir: `${outputRoot}/server/ssr`,
    }),
    cloudflare({
      configPath: workersCache ? "./wrangler.workers-cache.jsonc" : "./wrangler.jsonc",
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
