import { defineConfig } from "vite";
import vinext from "vinext";

export default defineConfig({
  // The e2e build covers a custom build.outDir for a hybrid App + Pages app.
  build: { outDir: "out" },
  plugins: [vinext({ appDir: import.meta.dirname })],
});
