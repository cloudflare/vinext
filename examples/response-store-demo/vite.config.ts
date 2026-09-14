import { defineConfig } from "vite";
import vinext from "vinext";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

const selfContained = process.env.VINEXT_RESPONSE_STORE_MODE === "self-contained";
const serviceName = process.env.VINEXT_RESPONSE_STORE_SERVICE_NAME;
const outputRoot = selfContained ? ".vinext/response-store-self-contained" : "dist";

export default defineConfig({
  plugins: [
    vinext({
      cache: responseStoreAdapter({
        mode: selfContained ? "self-contained" : "service-binding",
        ...(serviceName ? { serviceName } : {}),
      }),
      clientOutDir: `${outputRoot}/client`,
      rscOutDir: `${outputRoot}/server`,
      ssrOutDir: `${outputRoot}/server/ssr`,
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
