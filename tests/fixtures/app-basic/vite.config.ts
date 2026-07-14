import { defineConfig } from "vite";
import vinext from "vinext";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    vinext({
      appDir: import.meta.dirname,
      images: {
        optimizer: {
          adapter: fileURLToPath(new URL("./image-test-optimizer.ts", import.meta.url)),
        },
      },
    }),
  ],
});
