import { defineConfig } from "vite";
import vinext from "vinext";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreAdapter(),
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
