import { cloudflare } from "@cloudflare/vite-plugin";
import { workersCacheCdnAdapter } from "@vinext/cloudflare/cache/workers-cache-cdn-adapter";
import { defineConfig } from "vite";
import vinext from "vinext";

// A multi-stage Pages Router Worker build, prerendered by the build itself.
export default defineConfig({
  environments: { ssr: { build: { outDir: "dist/server" } } },
  plugins: [
    vinext({ prerender: true, cache: { cdn: workersCacheCdnAdapter() } }),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
  ],
});
