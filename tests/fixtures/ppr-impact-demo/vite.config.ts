import { cloudflare } from "@cloudflare/vite-plugin";
import { originCdnAdapter } from "@vinext/cloudflare/cache/origin-cdn-adapter";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({
      cache: { cdn: originCdnAdapter() },
      prerender: { routes: "*" },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
