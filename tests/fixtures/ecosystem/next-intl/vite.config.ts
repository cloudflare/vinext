import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  resolve: {
    alias: {
      "next-intl/config": fileURLToPath(new URL("./i18n/request.ts", import.meta.url)),
    },
  },
});
