import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { externalizeMissingEsmTripwire } from "./esm-externals-test-plugin";

export default defineConfig({
  plugins: [
    externalizeMissingEsmTripwire(),
    vinext(),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
});
