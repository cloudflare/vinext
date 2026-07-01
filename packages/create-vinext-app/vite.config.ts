import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const vinextSrc = fileURLToPath(new URL("../vinext/src", import.meta.url));

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      skipNodeModulesBundle: true,
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    inputOptions: {
      resolve: {
        alias: {
          // A create-* package must run before vinext is installed in the new
          // app, so bundle the shared init helpers instead of externalizing
          // `vinext/internal/*` imports to the generated project's dependency.
          "vinext/internal": vinextSrc,
        },
      },
    },
    unbundle: true,
  },
});
