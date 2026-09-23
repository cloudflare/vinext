import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import path from "node:path";

const responseStoreE2e = process.env.VINEXT_RESPONSE_STORE_E2E === "1";

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreE2e ? responseStoreAdapter({ mode: "self-contained" }) : undefined,
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare({
      configPath: responseStoreE2e ? "./wrangler.response-store.jsonc" : undefined,
      // The worker entry runs in the RSC environment, with SSR as a child.
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@test/og-font": path.resolve(
        import.meta.dirname,
        "../../tests/fixtures/og-font-package/lib",
      ),
    },
  },
});
