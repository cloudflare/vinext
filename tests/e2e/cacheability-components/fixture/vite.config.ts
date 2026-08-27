// @ts-nocheck
// This isolated non-workspace fixture receives its dependencies from the
// Playwright web-server setup immediately before the production build.
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "../../../../packages/cloudflare/src/cache/cdn-adapter.js";

export default defineConfig({
  plugins: [
    // This fixture deliberately contains routes that Next.js rejects at
    // runtime (for example, private cache scopes nested in shared caches).
    // Keep it runtime-only so those negative cases do not make the fixture's
    // production build fail before workerd can exercise the probe boundary.
    vinext({ cache: { cdn: cdnAdapter() } }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
