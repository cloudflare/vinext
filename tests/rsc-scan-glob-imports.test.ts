import type { RscPluginManager } from "@vitejs/plugin-rsc";
import { describe, expect, it } from "vite-plus/test";
import { createRscScanGlobImportsPlugin } from "../packages/vinext/src/plugins/rsc-scan-glob-imports.js";

function resolveWith(isScanBuild: boolean, source: string) {
  const plugin = createRscScanGlobImportsPlugin({
    getManager: async () => ({ isScanBuild }) as RscPluginManager,
  });
  const resolveId = plugin.resolveId as {
    filter: { id: RegExp };
    handler: (source: string) => Promise<unknown>;
  };
  if (!resolveId.filter.id.test(source)) return undefined;
  return resolveId.handler.call({ environment: { config: {} } }, source);
}

describe("vinext:rsc-scan-glob-imports", () => {
  it("keeps glob specifiers from plugin-rsc's scan build external", async () => {
    // es-module-lexer v3 reports `import(`file://${p}`)` as "file://*".
    await expect(resolveWith(true, "file://*")).resolves.toEqual({
      id: "file://*",
      external: true,
    });
    await expect(resolveWith(true, "*?v=*")).resolves.toEqual({ id: "*?v=*", external: true });
  });

  it("leaves real builds and plain specifiers to the normal resolver", async () => {
    await expect(resolveWith(false, "file://*")).resolves.toBeUndefined();
    expect(resolveWith(true, "./page.js")).toBeUndefined();
  });
});
