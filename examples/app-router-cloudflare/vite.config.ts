import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      // Link RSC/SSR as child environments so they're built with workerd
      // conditions and bundled into the Worker output.
      viteEnvironment: {
        childEnvironments: ["rsc", "ssr"],
      },
    }),
  ],
});
