import { cloudflare } from "@cloudflare/vite-plugin";
import { workersCacheCdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      cache: { cdn: workersCacheCdnAdapter() },
      disableAppRouter: true,
    }),
    cloudflare(),
  ],
});
