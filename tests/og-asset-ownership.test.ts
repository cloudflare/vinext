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

  it("recognizes an external package from its resolved directory alias path", async () => {
    const projectRoot = path.join(tmpDir, "resolved-alias-app");
    const packageRoot = path.join(tmpDir, "resolved-alias-package");
    const modulePath = path.join(packageRoot, "dist", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"@test/og-font"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [
      { find: "@test/og-font", replacement: path.join(packageRoot, "dist") },
    ]);
    const realPackageRoot = await fs.realpath(packageRoot);

    const boundary = await ownership.resolveModuleBoundary(modulePath);

    expect(boundary?.assetRoot).toBe(realPackageRoot);
  });

  it("does not broaden a resolved alias to an external non-package directory", async () => {
    const workspaceRoot = path.join(tmpDir, "resolved-non-package-workspace");
    const projectRoot = path.join(workspaceRoot, "app");
    const aliasRoot = path.join(workspaceRoot, "components");
    const modulePath = path.join(aliasRoot, "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(aliasRoot, { recursive: true });
    await fs.writeFile(path.join(workspaceRoot, "package.json"), '{"name":"workspace"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [{ find: "@components", replacement: aliasRoot }]);

    await expect(ownership.resolveModuleBoundary(modulePath)).resolves.toBeNull();
  });

  it("recognizes a resolved scoped package through a regex capture alias", async () => {
    const projectRoot = path.join(tmpDir, "resolved-regex-app");
    const packagesRoot = path.join(tmpDir, "resolved-regex-packages");
    const packageRoot = path.join(packagesRoot, "ui");
    const modulePath = path.join(packageRoot, "lib", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"@scope/ui"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [
      { find: /^@scope\/(.*)$/, replacement: `${packagesRoot}/$1/lib` },
    ]);
    const realPackageRoot = await fs.realpath(packageRoot);

    await expect(ownership.resolveModuleBoundary(modulePath)).resolves.toEqual({
      assetRoot: realPackageRoot,
      moduleDir: await fs.realpath(path.dirname(modulePath)),
    });
  });

  it("does not apply a regex capture alias to an unrelated sibling package", async () => {
    const projectRoot = path.join(tmpDir, "resolved-regex-sibling-app");
    const packagesRoot = path.join(tmpDir, "resolved-regex-sibling-packages");
    const packageRoot = path.join(packagesRoot, "other");
    const modulePath = path.join(packageRoot, "src", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"unrelated-package"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [
      { find: /^@scope\/(.*)$/, replacement: `${packagesRoot}/$1/lib` },
    ]);

    await expect(ownership.resolveModuleBoundary(modulePath)).resolves.toBeNull();
  });

  it("does not broaden a regex capture directory within the owning package", async () => {
    const projectRoot = path.join(tmpDir, "resolved-regex-outside-app");
    const packagesRoot = path.join(tmpDir, "resolved-regex-outside-packages");
    const packageRoot = path.join(packagesRoot, "ui");
    const modulePath = path.join(packageRoot, "src", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.join(packageRoot, "lib"), { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"@scope/ui"}');
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [
      { find: /^@scope\/(.*)$/, replacement: `${packagesRoot}/$1/lib` },
    ]);

    await expect(ownership.resolveModuleBoundary(modulePath)).resolves.toBeNull();
  });

  it("does not broaden a regex capture file target within the owning package", async () => {
    const projectRoot = path.join(tmpDir, "resolved-regex-file-app");
    const packagesRoot = path.join(tmpDir, "resolved-regex-file-packages");
    const packageRoot = path.join(packagesRoot, "ui");
    const entryPath = path.join(packageRoot, "lib", "index.js");
    const modulePath = path.join(packageRoot, "lib", "chunk.js");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.dirname(modulePath), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"name":"@scope/ui"}');
    await fs.writeFile(entryPath, "export {};");
    await fs.writeFile(modulePath, "export {};");

    const ownership = new OgAssetOwnership();
    ownership.configure(projectRoot, [
      { find: /^@scope\/(.*)$/, replacement: `${packagesRoot}/$1/lib/index.js` },
    ]);

    await expect(ownership.resolveModuleBoundary(modulePath)).resolves.toBeNull();
    await expect(ownership.resolveModuleBoundary(entryPath)).resolves.not.toBeNull();
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
