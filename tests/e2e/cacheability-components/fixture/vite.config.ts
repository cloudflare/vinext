// @ts-nocheck
// This isolated non-workspace fixture receives its dependencies from the
// Playwright web-server setup immediately before the production build.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "../../../../packages/cloudflare/src/cache/cdn-adapter.js";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: cdnAdapter() }, prerender: { routes: "*" } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
