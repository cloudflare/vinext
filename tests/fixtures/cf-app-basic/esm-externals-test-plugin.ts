import type { Plugin } from "vite";

export function externalizeMissingEsmTripwire(): Plugin {
  return {
    name: "test:externalize-missing-esm-tripwire",
    resolveDynamicImport(source) {
      if (source === "fail") return { id: source, external: true };
    },
    resolveId: {
      filter: { id: /^fail$/ },
      handler(source) {
        // The upstream ESM-externals fixture uses an unreachable import of this
        // deliberately missing package to prove its Node package stays external.
        // Worker packages are bundled, but workerd likewise resolves a dynamic
        // import only if it executes, so preserve that tripwire in the output.
        return { id: source, external: true };
      },
    },
  };
}
