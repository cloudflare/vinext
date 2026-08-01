import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

const useCdnCache = process.env.VINEXT_TEST_CDN_CACHE === "1";

export default defineConfig({
  plugins: [
    vinext(useCdnCache ? { cache: { cdn: cdnAdapter() }, prerender: { routes: "*" } } : undefined),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
