import { afterEach, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getNextStaticAssetLookupPath,
  isNextStaticAssetPath,
  writeNextStaticCompatAssets,
} from "../packages/vinext/src/server/next-static-compat.js";
import { StaticFileCache } from "../packages/vinext/src/server/static-file-cache.js";

describe("Next static asset compatibility", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  async function makeClientDir(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-next-static-"));
    tempDirs.push(dir);
    return dir;
  }

  it("identifies _next/static asset requests", () => {
    expect(isNextStaticAssetPath("/_next/static/build/_buildManifest.js")).toBe(true);
    expect(isNextStaticAssetPath("/_next/static/invalid-path")).toBe(true);
    expect(isNextStaticAssetPath("/_next/data/build/index.json")).toBe(false);
    expect(isNextStaticAssetPath("/assets/app.js")).toBe(false);
  });

  it("maps path assetPrefix _next/static requests to the emitted lookup path", () => {
    // Ported from Next.js: test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-asset-prefix.test.ts
    // https://github.com/vercel/next.js/blob/canary/test/e2e/invalid-static-asset-404-pages/invalid-static-asset-404-pages-asset-prefix.test.ts
    expect(
      getNextStaticAssetLookupPath("/assets/_next/static/build/_buildManifest.js", "/assets"),
    ).toBe("/_next/static/build/_buildManifest.js");
    expect(getNextStaticAssetLookupPath("/assets/_next/static/invalid-path", "/assets/")).toBe(
      "/_next/static/invalid-path",
    );
    expect(getNextStaticAssetLookupPath("/assets/app.js", "/assets")).toBe("/assets/app.js");
    expect(getNextStaticAssetLookupPath("/_next/static/invalid-path", "/assets")).toBe(
      "/_next/static/invalid-path",
    );
  });

  it("emits a static _buildManifest.js file under the build id", async () => {
    const clientDir = await makeClientDir();

    writeNextStaticCompatAssets(clientDir, "build-123");

    const cache = await StaticFileCache.create(clientDir);
    const entry = cache.lookup("/_next/static/build-123/_buildManifest.js");
    expect(entry).toBeDefined();
    expect(entry!.original.headers["Content-Type"]).toBe("application/javascript");
    expect(entry!.original.buffer?.toString("utf-8")).toContain("__BUILD_MANIFEST");
  });
});
