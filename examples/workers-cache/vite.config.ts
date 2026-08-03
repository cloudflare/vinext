import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

const prepareRscWarmPreview = process.env.VINEXT_PREPARE_RSC_WARM_PREVIEW === "1";

export default defineConfig({
  plugins: [
    vinext({
      cache: {
        cdn: cdnAdapter(),
        data: kvDataAdapter(),
      },
      prerender: prepareRscWarmPreview ? { routes: "*" } : undefined,
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
