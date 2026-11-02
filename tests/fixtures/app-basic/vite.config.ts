import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
  // This local CommonJS package exercises an optional canvas peer without
  // installing a native addon or adding a third-party test dependency.
  optimizeDeps: { include: ["@/__test_packages__/optional-canvas/index.cjs"] },
});
