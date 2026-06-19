import { defineConfig } from "vite";
import vinext from "vinext";
import path from "node:path";

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
  resolve: {
    alias: {
      "@test/og-font": path.resolve(import.meta.dirname, "../og-font-package"),
    },
  },
});
