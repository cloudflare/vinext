import path from "node:path";
import { defineConfig } from "vite";

import { cloudflare } from "../../../fixtures/cf-app-basic/node_modules/@cloudflare/vite-plugin/dist/index.mjs";
import vinext from "../../../../packages/vinext/src/index.js";

export default defineConfig({
  plugins: [
    vinext({ appDir: import.meta.dirname }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
    }),
  ],
  resolve: {
    // The upstream fixture declares @resvg/resvg-wasm@2.4.0. It is already
    // present in vinext's lockfile through @vercel/og, but this isolated E2E
    // fixture is not a workspace package, so resolve that locked copy directly.
    alias: {
      "@resvg/resvg-wasm": path.resolve(
        import.meta.dirname,
        "../../../../node_modules/.pnpm/node_modules/@resvg/resvg-wasm",
      ),
    },
  },
});
