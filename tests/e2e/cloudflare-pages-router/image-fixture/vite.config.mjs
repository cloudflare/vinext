import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite-plus";
import vinext from "vinext";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    vinext({
      images: {
        optimizer: {
          adapter: fileURLToPath(new URL("./image-test-optimizer.mjs", import.meta.url)),
        },
      },
    }),
    cloudflare(),
  ],
});
