import vinext from "vinext";
import { defineConfig } from "vite-plus";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { cloudflare } from "@cloudflare/vite-plugin";

const responseStoreServiceName = process.env.VINEXT_RESPONSE_STORE_SERVICE_NAME;

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreAdapter(
        responseStoreServiceName ? { serviceName: responseStoreServiceName } : undefined,
      ),
      images: {
        optimizer: imagesOptimizer(),
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
