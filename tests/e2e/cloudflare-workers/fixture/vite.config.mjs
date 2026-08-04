import { cloudflare } from "@cloudflare/vite-plugin";
import { originCdnAdapter } from "@vinext/cloudflare/cache/origin-cdn-adapter";
import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: originCdnAdapter() } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
