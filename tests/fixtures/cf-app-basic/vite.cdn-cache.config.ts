import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "../../../packages/cloudflare/dist/cache/cdn-adapter.js";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: cdnAdapter() } }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
