import { defineConfig } from "vite-plus";

const bundledDeps = [
  "@jridgewell/sourcemap-codec",
  "am-i-vibing",
  "magic-string",
  "process-ancestry",
];

const externalizeBareThirdPartySpecifiers = (
  id: string,
  _importer: string | undefined,
  isResolved: boolean,
) => {
  if (isResolved) return false;
  if (id.startsWith(".") || id.startsWith("/") || id.startsWith("\0") || id.includes(":")) {
    return false;
  }
  if (id === "vinext" || id.startsWith("vinext/")) return false;
  if (bundledDeps.includes(id)) return false;
  return true;
};

export default defineConfig({
  pack: {
    entry: ["src/**/*.ts", "!src/**/*.d.ts"],
    clean: true,
    deps: {
      alwaysBundle: bundledDeps,
      neverBundle: (id) =>
        id.includes("node_modules") && !bundledDeps.some((dep) => id.includes(dep)),
    },
    dts: true,
    fixedExtension: false,
    format: "esm",
    inputOptions: {
      external: externalizeBareThirdPartySpecifiers,
    },
    unbundle: true,
  },
});
