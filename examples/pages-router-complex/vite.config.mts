import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { kvDataAdapter } from "@vinext/cloudflare/cache/kv-data-adapter";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

// Scaffolded with `vinext init` (Cloudflare, Pages Router), plus the
// workspace alias — the tooling layer owns it on every bundler (the webpack
// hook in next.config.js does the same for the Next.js ground-truth runs),
// while tsconfig `paths` stays authoritative for the type checker.
export default defineConfig({
  plugins: [
    vinext({
      cache: { data: kvDataAdapter(), cdn: cdnAdapter() },
      images: { optimizer: imagesOptimizer() },
    }),
    cloudflare(),
  ],
  resolve: {
    alias: {
      "@atlas": fileURLToPath(new URL("./lib", import.meta.url)),
    },
  },
});
