import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "../../../packages/cloudflare/src/cache/cdn-adapter.js";
import { kvDataAdapter } from "../../../packages/cloudflare/src/cache/kv-data-adapter.js";

export default defineConfig({
  plugins: [
    vinext({
      cache: { cdn: cdnAdapter(), data: kvDataAdapter() },
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
