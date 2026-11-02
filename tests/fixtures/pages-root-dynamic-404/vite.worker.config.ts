import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import vinext from "vinext";

// The single-stage Pages Router Worker setup `vinext init` writes, prerendered
// by the build itself.
export default defineConfig({
  environments: { ssr: { build: { outDir: "dist/server" } } },
  plugins: [vinext({ prerender: true }), cloudflare({ viteEnvironment: { name: "ssr" } })],
});
