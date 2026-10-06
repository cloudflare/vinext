import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { staticAssetsAdapter } from "@vinext/cloudflare/cache/static-assets-adapter";

export default defineConfig({
  environments: { ssr: { build: { outDir: "dist/server" } } },
  plugins: [
    // A custom binding name also covers adapters that do not use env.ASSETS.
    vinext({ prerender: true, cache: { cdn: staticAssetsAdapter({ binding: "STATIC" }) } }),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
  ],
});
