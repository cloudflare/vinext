import { defineConfig } from "vite-plus";

const typescriptPackageUrl = import.meta.resolve("typescript/package.json");
const { default: getTscPath } = await import(
  new URL("lib/getExePath.js", typescriptPackageUrl).href
);

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts"],
    clean: true,
    deps: {
      neverBundle: true,
    },
    dts: {
      tsgo: { path: getTscPath() },
    },
    fixedExtension: false,
    format: "esm",
    inputOptions: {
      external: (id) => id.startsWith("cloudflare:"),
    },
    tsconfig: "./tsconfig.json",
    unbundle: true,
  },
});
