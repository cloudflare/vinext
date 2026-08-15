import { defineConfig } from "vite";

// This isolated E2E fixture is not a workspace package, so resolve the plugin
// from source while its runtime dependencies come from the temporary node_modules link.
import vinext from "../../../../../packages/vinext/src/index.js";

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
