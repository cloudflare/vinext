import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServerExternalsManifestPlugin } from "../packages/vinext/src/plugins/server-externals-manifest.js";

describe("createServerExternalsManifestPlugin", () => {
  it("ignores bundle files, virtual modules, and node builtins when writing the manifest", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-externals-manifest-"));
    const outDir = path.join(tmpDir, "dist", "server");
    fs.mkdirSync(outDir, { recursive: true });

    try {
      const plugin = createServerExternalsManifestPlugin();
      const writeBundle = (plugin.writeBundle as { handler: Function }).handler;

      writeBundle.call(
        { environment: { name: "ssr" } },
        { dir: outDir },
        {
          "index.js": {
            type: "chunk",
            imports: [
              "react",
              "@scope/pkg/subpath",
              "ipaddr.js",
              "index.js",
              "assets/chunk-abc.js",
              "virtual:vite-rsc",
              "crypto",
              "fs/promises",
              "node:path",
            ],
            dynamicImports: ["react-dom/server.edge"],
          },
          "assets/chunk-abc.js": {
            type: "chunk",
            imports: [],
            dynamicImports: [],
          },
        },
      );

      const manifest = JSON.parse(
        fs.readFileSync(path.join(outDir, "vinext-externals.json"), "utf-8"),
      ) as string[];

      expect(manifest.sort()).toEqual(["@scope/pkg", "ipaddr.js", "react", "react-dom"].sort());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
