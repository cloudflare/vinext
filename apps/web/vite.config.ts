import vinext from "vinext";
import { defineConfig } from "vite-plus";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { cloudflare } from "@cloudflare/vite-plugin";
import { responseStoreServiceBinding } from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreAdapter(),
      images: {
        optimizer: imagesOptimizer(),
      },
    }),
    cloudflare({
      auxiliaryWorkers: [{ config: responseStoreServiceBinding }],
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
