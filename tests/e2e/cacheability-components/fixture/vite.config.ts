// @ts-nocheck
// This isolated non-workspace fixture receives its dependencies from the
// Playwright web-server setup immediately before the production build.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import vinext from "vinext";
import { workersCacheCdnAdapter } from "../../../../packages/cloudflare/src/cache/workers-cache-cdn-adapter.js";

export default defineConfig({
  // The e2e build covers a custom build.outDir on Cloudflare.
  build: { outDir: "out" },
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
