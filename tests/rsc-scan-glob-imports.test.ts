import type { RscPluginManager } from "@vitejs/plugin-rsc";
import { describe, expect, it } from "vite-plus/test";
import {
  createRscScanGlobImportsPlugin,
  isRscScanGlobImportsAffected,
} from "../packages/vinext/src/plugins/rsc-scan-glob-imports.js";

// Stands in for Vite's resolver: a real file whose name contains `*`, a
// relative glob that matches no file, and an invalid `file://` URL.
async function resolve(source: string) {
  if (source === "./c*d.js") return { id: "/app/c*d.js" };
  if (source === "file://*") throw new Error("Invalid file URL: must not contain hostname");
  return null;
}

function resolveWith(isScanBuild: boolean, source: string) {
  const plugin = createRscScanGlobImportsPlugin({
    getManager: async () => ({ isScanBuild }) as RscPluginManager,
  });
  const resolveId = plugin.resolveId as {
    filter: { id: RegExp };
    handler: (source: string, importer: string, options: object) => Promise<unknown>;
  };
  if (!resolveId.filter.id.test(source)) return undefined;
  return resolveId.handler.call(
    { environment: { config: {} }, resolve },
    source,
    "/app/page.js",
    {},
  );
}

describe("vinext:rsc-scan-glob-imports", () => {
  it("keeps unresolvable glob specifiers from plugin-rsc's scan build external", async () => {
    // es-module-lexer v3 reports `import(`file://${p}`)` as "file://*".
    await expect(resolveWith(true, "file://*")).resolves.toEqual({
      id: "file://*",
      external: true,
    });
    await expect(resolveWith(true, "./locales/*.js")).resolves.toEqual({
      id: "./locales/*.js",
      external: true,
    });
  });

  it("keeps real modules whose specifier contains * in the scan graph", async () => {
    await expect(resolveWith(true, "./c*d.js")).resolves.toEqual({ id: "/app/c*d.js" });
  });

  it("leaves real builds and plain specifiers to the normal resolver", async () => {
    await expect(resolveWith(false, "file://*")).resolves.toBeUndefined();
    expect(resolveWith(true, "./page.js")).toBeUndefined();
  });

  it("only applies to plugin-rsc releases without the upstream glob fix", () => {
    expect(isRscScanGlobImportsAffected("0.5.35")).toBe(false);
    expect(isRscScanGlobImportsAffected("0.5.36")).toBe(true);
    expect(isRscScanGlobImportsAffected("0.5.37")).toBe(true);
    expect(isRscScanGlobImportsAffected("0.5.38")).toBe(false);
    expect(isRscScanGlobImportsAffected("0.6.0")).toBe(false);
  });
});
