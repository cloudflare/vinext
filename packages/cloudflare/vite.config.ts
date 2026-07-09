import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const tscPath = fileURLToPath(new URL("bin/tsc", import.meta.resolve("typescript/package.json")));

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      skipNodeModulesBundle: true,
    },
    dts: {
      tsgo: { path: tscPath },
    },
    fixedExtension: false,
    format: "esm",
    tsconfig: "../../tsconfig.cloudflare-dts.json",
    unbundle: true,
  },
});
