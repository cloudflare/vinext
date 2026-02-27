import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitStandaloneOutput } from "../packages/vinext/src/build/standalone.js";

let tmpDir: string;

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-standalone-test-"));
}

function writeFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
}

function writePackage(
  root: string,
  packageName: string,
  dependencies: Record<string, string> = {},
  options: { exports?: Record<string, string> } = {},
): void {
  const packageRoot = path.join(root, "node_modules", packageName);
  fs.mkdirSync(packageRoot, { recursive: true });
  const pkgJson: Record<string, unknown> = {
    name: packageName,
    version: "1.0.0",
    main: "index.js",
    dependencies,
  };
  if (options.exports) {
    pkgJson.exports = options.exports;
  }
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify(pkgJson, null, 2),
    "utf-8",
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), "module.exports = {};\n", "utf-8");
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("emitStandaloneOutput", () => {
  it("creates standalone output with runtime deps and entry script", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot, { recursive: true });

    writeFile(
      appRoot,
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: {
          "dep-a": "1.0.0",
          react: "1.0.0",
          vinext: "1.0.0",
        },
        devDependencies: {
          // This is intentionally in devDependencies. The standalone builder
          // should still copy it because the server bundle imports it directly.
          "react-server-dom-webpack": "1.0.0",
          typescript: "5.0.0",
        },
      }, null, 2),
    );

    writeFile(appRoot, "dist/client/assets/main.js", "console.log('client');\n");
    writeFile(
      appRoot,
      "dist/server/entry.js",
      'import "react-server-dom-webpack/server.edge";\nconsole.log("server");\n',
    );
    writeFile(appRoot, "public/robots.txt", "User-agent: *\n");

    writePackage(appRoot, "dep-a", { "dep-b": "1.0.0" });
    writePackage(appRoot, "dep-b");
    writePackage(appRoot, "react");
    writePackage(appRoot, "react-server-dom-webpack");

    const fakeVinextRoot = path.join(tmpDir, "fake-vinext");
    writeFile(
      fakeVinextRoot,
      "package.json",
      JSON.stringify({
        name: "vinext",
        version: "0.0.0-test",
        type: "module",
      }, null, 2),
    );
    writeFile(fakeVinextRoot, "dist/server/prod-server.js", "export async function startProdServer() {}\n");

    const result = emitStandaloneOutput({
      root: appRoot,
      outDir: path.join(appRoot, "dist"),
      vinextPackageRoot: fakeVinextRoot,
    });

    expect(result.copiedPackages).toContain("dep-a");
    expect(result.copiedPackages).toContain("dep-b");
    expect(result.copiedPackages).toContain("react");
    expect(result.copiedPackages).toContain("react-server-dom-webpack");
    expect(result.copiedPackages).toContain("vinext");

    expect(fs.existsSync(path.join(appRoot, "dist/standalone/server.js"))).toBe(true);
    expect(
      fs.readFileSync(path.join(appRoot, "dist/standalone/server.js"), "utf-8"),
    ).toContain("startProdServer");
    const standalonePkg = JSON.parse(
      fs.readFileSync(path.join(appRoot, "dist/standalone/package.json"), "utf-8"),
    ) as { type: string };
    expect(standalonePkg.type).toBe("commonjs");

    expect(fs.existsSync(path.join(appRoot, "dist/standalone/dist/client/assets/main.js"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/dist/server/entry.js"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/public/robots.txt"))).toBe(true);

    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/dep-a/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/dep-b/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/react/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/react-server-dom-webpack/package.json"))).toBe(true);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/typescript/package.json"))).toBe(false);
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/vinext/dist/server/prod-server.js"))).toBe(true);
  });

  it("throws when dist/client or dist/server are missing", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot, { recursive: true });
    writeFile(appRoot, "package.json", JSON.stringify({ name: "app" }, null, 2));

    expect(() =>
      emitStandaloneOutput({
        root: appRoot,
        outDir: path.join(appRoot, "dist"),
      }),
    ).toThrow("Run vinext build first.");
  });

  it("falls back when package.json is hidden by exports map", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot, { recursive: true });

    writeFile(
      appRoot,
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: {
          "dep-hidden": "1.0.0",
          vinext: "1.0.0",
        },
      }, null, 2),
    );
    writeFile(appRoot, "dist/client/assets/main.js", "console.log('client');\n");
    writeFile(appRoot, "dist/server/entry.js", "import 'dep-hidden';\n");

    writePackage(appRoot, "dep-hidden", {}, { exports: { ".": "./index.js" } });

    const fakeVinextRoot = path.join(tmpDir, "fake-vinext");
    writeFile(fakeVinextRoot, "package.json", JSON.stringify({ name: "vinext", type: "module" }, null, 2));
    writeFile(fakeVinextRoot, "dist/server/prod-server.js", "export async function startProdServer() {}\n");

    const result = emitStandaloneOutput({
      root: appRoot,
      outDir: path.join(appRoot, "dist"),
      vinextPackageRoot: fakeVinextRoot,
    });

    expect(result.copiedPackages).toContain("dep-hidden");
    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/dep-hidden/package.json"))).toBe(true);
  });

  it("throws when a required runtime dependency cannot be resolved", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot, { recursive: true });

    writeFile(
      appRoot,
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: {
          "missing-required": "1.0.0",
          vinext: "1.0.0",
        },
      }, null, 2),
    );
    writeFile(appRoot, "dist/client/assets/main.js", "console.log('client');\n");
    writeFile(appRoot, "dist/server/entry.js", "console.log('server');\n");

    const fakeVinextRoot = path.join(tmpDir, "fake-vinext");
    writeFile(fakeVinextRoot, "package.json", JSON.stringify({ name: "vinext", type: "module" }, null, 2));
    writeFile(fakeVinextRoot, "dist/server/prod-server.js", "export async function startProdServer() {}\n");

    expect(() =>
      emitStandaloneOutput({
        root: appRoot,
        outDir: path.join(appRoot, "dist"),
        vinextPackageRoot: fakeVinextRoot,
      }),
    ).toThrow('Failed to resolve required runtime dependency "missing-required"');
  });

  it("copies packages referenced through symlinked node_modules entries", () => {
    const appRoot = path.join(tmpDir, "app");
    fs.mkdirSync(appRoot, { recursive: true });

    writeFile(
      appRoot,
      "package.json",
      JSON.stringify({
        name: "app",
        dependencies: {
          "dep-link": "1.0.0",
          vinext: "1.0.0",
        },
      }, null, 2),
    );
    writeFile(appRoot, "dist/client/assets/main.js", "console.log('client');\n");
    writeFile(appRoot, "dist/server/entry.js", "import 'dep-link';\n");

    const storeDir = path.join(tmpDir, "store", "dep-link");
    fs.mkdirSync(storeDir, { recursive: true });
    writeFile(storeDir, "package.json", JSON.stringify({ name: "dep-link", version: "1.0.0", main: "index.js" }, null, 2));
    writeFile(storeDir, "index.js", "module.exports = {};\n");

    const nodeModulesDir = path.join(appRoot, "node_modules");
    fs.mkdirSync(nodeModulesDir, { recursive: true });
    fs.symlinkSync(storeDir, path.join(nodeModulesDir, "dep-link"), "dir");

    const fakeVinextRoot = path.join(tmpDir, "fake-vinext");
    writeFile(fakeVinextRoot, "package.json", JSON.stringify({ name: "vinext", type: "module" }, null, 2));
    writeFile(fakeVinextRoot, "dist/server/prod-server.js", "export async function startProdServer() {}\n");

    emitStandaloneOutput({
      root: appRoot,
      outDir: path.join(appRoot, "dist"),
      vinextPackageRoot: fakeVinextRoot,
    });

    expect(fs.existsSync(path.join(appRoot, "dist/standalone/node_modules/dep-link/package.json"))).toBe(true);
    expect(fs.lstatSync(path.join(appRoot, "dist/standalone/node_modules/dep-link")).isSymbolicLink()).toBe(false);
  });
});
