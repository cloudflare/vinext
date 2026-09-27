import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { workersCacheCdnAdapter } from "../../../packages/cloudflare/src/cache/workers-cache-cdn-adapter.js";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: workersCacheCdnAdapter() }, prerender: { routes: "*" } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
