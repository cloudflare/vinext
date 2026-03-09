import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext()],
  resolve: {
    alias: {
      "next/navigation.js": fileURLToPath(
        new URL("../../../../packages/vinext/src/shims/navigation.ts", import.meta.url),
      ),
      "next/compat/router.js": fileURLToPath(
        new URL("../../../../packages/vinext/src/shims/compat-router.ts", import.meta.url),
      ),
    },
  },
  ssr: {
    // Force nuqs through Vite's transform pipeline so our next/* aliases work
    noExternal: ["nuqs"],
  },
});
