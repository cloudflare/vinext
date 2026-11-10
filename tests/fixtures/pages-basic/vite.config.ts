import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  plugins: [
    vinext(),
    {
      // Emits a client file at the output root, as Module Federation does
      // with `remoteEntry.js`.
      name: "test:emit-client-build-file",
      apply: "build",
      generateBundle() {
        if (this.environment.name !== "client") return;
        this.emitFile({
          type: "asset",
          fileName: "pages-client-build-file.js",
          source: "export const remote = true;\n",
        });
      },
    },
  ],
});
