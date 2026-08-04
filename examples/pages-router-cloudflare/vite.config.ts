import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { originCdnAdapter } from "@vinext/cloudflare/cache/origin-cdn-adapter";

export default defineConfig({
  plugins: [
    vinext({ cache: { cdn: originCdnAdapter() } }),
    cloudflare(),
  ],
});
