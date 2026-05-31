import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  findClientEntryFile,
  findClientEntryFileFromManifest,
  readClientBuildManifest,
} from "../packages/vinext/src/utils/client-build-manifest.js";

describe("client build manifest helpers", () => {
  let tmpDir: string;
  let clientDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-client-build-manifest-"));
    clientDir = path.join(tmpDir, "client");
    await fsp.mkdir(path.join(clientDir, ".vite"), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads Vite manifest entries used for client entry and lazy chunk computation", async () => {
    const manifestPath = path.join(clientDir, ".vite", "manifest.json");
    await fsp.writeFile(
      manifestPath,
      JSON.stringify({
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
          imports: ["shared"],
          dynamicImports: ["lazy"],
          css: ["_next/static/client.css"],
          assets: ["_next/static/logo.svg"],
        },
      }),
    );

    const manifest = readClientBuildManifest(manifestPath);

    expect(manifest).toEqual({
      "pages-client-entry.ts": {
        file: "_next/static/vinext-client-entry-abcd.js",
        isEntry: true,
        imports: ["shared"],
        dynamicImports: ["lazy"],
        css: ["_next/static/client.css"],
        assets: ["_next/static/logo.svg"],
      },
    });
  });

  it("finds the client entry from the manifest before scanning disk", () => {
    const entry = findClientEntryFileFromManifest(
      {
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
        },
      },
      "/docs/",
    );

    expect(entry).toBe("docs/_next/static/vinext-client-entry-abcd.js");
  });

  it("prefers the marked client entry over other isEntry chunks regardless of order", () => {
    const entry = findClientEntryFileFromManifest(
      {
        "instrumentation-client.ts": {
          file: "_next/static/vinext-instrumentation-client-0001.js",
          isEntry: true,
        },
        "pages-client-entry.ts": {
          file: "_next/static/vinext-client-entry-abcd.js",
          isEntry: true,
        },
      },
      "/",
    );

    expect(entry).toBe("_next/static/vinext-client-entry-abcd.js");
  });

  it("falls back to the on-disk assets directory when the manifest has no entry", async () => {
    const assetsSubdir = "_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "shared.js"), "");
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-client-entry-1234.js"), "");

    const entry = findClientEntryFile({
      buildManifest: {},
      clientDir,
      assetsSubdir,
      assetBase: "/docs/",
    });

    expect(entry).toBe("docs/_next/static/vinext-client-entry-1234.js");
  });

  it("uses the asset-prefix assets subdirectory for fallback entry lookup", async () => {
    const assetsSubdir = "cdn/_next/static";
    await fsp.mkdir(path.join(clientDir, assetsSubdir), { recursive: true });
    await fsp.writeFile(path.join(clientDir, assetsSubdir, "vinext-client-entry-5678.js"), "");

    const entry = findClientEntryFile({
      clientDir,
      assetsSubdir,
      assetBase: "/",
    });

    expect(entry).toBe("cdn/_next/static/vinext-client-entry-5678.js");
  });
});
