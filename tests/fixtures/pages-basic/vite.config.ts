import fs from "node:fs";
import { defineConfig } from "vite-plus";
import vinext from "vinext";

export default defineConfig({
  // The production e2e checks what browser sourcemaps include.
  environments: { client: { build: { sourcemap: true } } },
  plugins: [
    vinext(),
    {
      // Loads a page with its own sourcemap, as a preprocessing plugin would.
      name: "test:load-page-with-map",
      apply: "build",
      load(id) {
        if (!id.endsWith("/pages/sourcemap-data/loaded.tsx")) return null;
        const code = fs.readFileSync(id, "utf8");
        const lines = code.split("\n").length;
        return {
          code,
          map: {
            version: 3,
            sources: [id],
            sourcesContent: [code],
            names: [],
            mappings: ["AAAA", ...Array(lines - 1).fill("AACA")].join(";"),
          },
        };
      },
    },
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
