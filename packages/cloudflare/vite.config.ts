import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      skipNodeModulesBundle: true,
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    sourcemap: true,
    unbundle: true,
  },
});
