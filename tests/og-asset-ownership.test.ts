import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OgAssetOwnership } from "../packages/vinext/src/plugins/og-asset-ownership.js";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "og-asset-ownership-"));
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("OgAssetOwnership", () => {
  it("uses the project root for application modules", async () => {
    const projectRoot = path.join(tmpDir, "application");
    const modulePath = path.join(projectRoot, "app", "route.js");
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, []);
    const realProjectRoot = await fs.realpath(projectRoot);
    const realModuleDir = await fs.realpath(path.dirname(modulePath));

    const boundary = await ownership.resolveModuleBoundary(modulePath);

    expect(boundary).toEqual({ assetRoot: realProjectRoot, moduleDir: realModuleDir });
  });

  it("records an aliased external package as its own boundary", async () => {
    const projectRoot = path.join(tmpDir, "aliased-app");
    const packageRoot = path.join(tmpDir, "aliased-package");
    const modulePath = path.join(packageRoot, "dist", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"design-system"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [{ find: "@ui", replacement: packageRoot }]);
    await ownership.recordResolvedImport("@ui/dist/chunk.js", modulePath);
    const realPackageRoot = await fs.realpath(packageRoot);

    const boundary = await ownership.resolveModuleBoundary(modulePath);

    expect(boundary?.assetRoot).toBe(realPackageRoot);
  });

  it("rejects assets outside the resolved package boundary", async () => {
    const packageRoot = path.join(tmpDir, "contained-package");
    const assetPath = path.join(packageRoot, "font.ttf");
    const outsidePath = path.join(tmpDir, "secret.txt");
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(assetPath, "font");
    await fs.writeFile(outsidePath, "secret");
    const realPackageRoot = await fs.realpath(packageRoot);
    const realAssetPath = await fs.realpath(assetPath);

    const ownership = new OgAssetOwnership();

    await expect(ownership.resolveContainedAsset(realPackageRoot, assetPath)).resolves.toBe(
      realAssetPath,
    );
    await expect(ownership.resolveContainedAsset(realPackageRoot, outsidePath)).resolves.toBeNull();
  });
});
