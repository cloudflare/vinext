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
          "vinext/internal": vinextSrc,
        },
      },
    },
    unbundle: true,
  },
});
