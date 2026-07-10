import { defineConfig } from "vite-plus";
import vinext from "../../../../packages/vinext/src/index.js";

export default defineConfig({
  plugins: [vinext({ appDir: import.meta.dirname })],
});
