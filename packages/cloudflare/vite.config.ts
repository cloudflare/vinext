import { defineConfig } from "vite-plus";

const typescriptPackageUrl = import.meta.resolve("typescript/package.json");
const { default: getTscPath } = await import(
  new URL("lib/getExePath.js", typescriptPackageUrl).href
);

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "src/**/*.tsx", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      skipNodeModulesBundle: true,
    },
    dts: {
      tsgo: { path: getTscPath() },
    },
    fixedExtension: false,
    format: "esm",
    tsconfig: "../../tsconfig.cloudflare-dts.json",
    unbundle: true,
  },
});
