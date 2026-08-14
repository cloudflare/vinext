import { cloudflare } from "@cloudflare/vite-plugin";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { defineConfig } from "vite";
import vinext from "vinext";
import { externalizeMissingEsmTripwire } from "./esm-externals-test-plugin";

export default defineConfig({
  plugins: [
    externalizeMissingEsmTripwire(),
    vinext({ cache: { cdn: cdnAdapter() } }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
