import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "vinext/cloudflare/cache/kv-data-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        cdn: cdnAdapter(),
        data: kvDataAdapter(),
      },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
