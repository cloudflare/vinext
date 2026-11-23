import { defineConfig } from "vite";
import vinext from "vinext";
import { staticAssetsAdapter } from "@vinext/cloudflare/cache/static-assets-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  // CI deploys this example with both vinext-cloudflare and cf, so it also
  // covers a custom build.outDir end to end.
  build: { outDir: "out" },
  plugins: [
    vinext({
      cache: { cdn: staticAssetsAdapter() },
      prerender: { routes: "*" },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
