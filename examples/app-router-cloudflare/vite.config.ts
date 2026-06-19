import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import path from "node:path";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
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
