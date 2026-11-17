import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
  // Every dependency is external. Optimized packages must still be bundled so
  // their barrel imports are rewritten, as Next.js always bundles them.
  ssr: { external: true },
});
