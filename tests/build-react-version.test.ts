import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBuilder, type InlineConfig } from "vite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { VINEXT_BUILD_LIFECYCLE_CONFIG } from "../packages/vinext/src/build/lifecycle.js";
import vinext from "../packages/vinext/src/index.js";
import { testCacheDir } from "./helpers.js";

const repoNodeModules = path.resolve(import.meta.dirname, "../node_modules");

function createAppWithReact(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-react-version-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "react-version-app",
      private: true,
      type: "module",
      packageManager: "npm@10.9.0",
    }),
  );
  fs.mkdirSync(path.join(root, "app"));
  fs.writeFileSync(
    path.join(root, "app", "layout.tsx"),
    `export default function RootLayout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }`,
  );
  fs.writeFileSync(
    path.join(root, "app", "page.tsx"),
    `export default function Home() { return <h1>Home</h1>; }`,
  );
  // Link every repo dependency except React, which is replaced by a stub at
  // the requested version.
  const nodeModules = path.join(root, "node_modules");
  fs.mkdirSync(nodeModules);
  for (const entry of fs.readdirSync(repoNodeModules)) {
    if (entry === "react" || entry.startsWith(".")) continue;
    fs.symlinkSync(path.join(repoNodeModules, entry), path.join(nodeModules, entry), "junction");
  }
  const react = path.join(nodeModules, "react");
  fs.mkdirSync(react);
  fs.writeFileSync(
    path.join(react, "package.json"),
    JSON.stringify({ name: "react", version, main: "index.js" }),
  );
  fs.writeFileSync(path.join(react, "index.js"), "module.exports = {};");
  return root;
}

describe("vinext build React version check", () => {
  let root: string | undefined;
  // Loading next.config changes into the cwd and back, so restore it.
  const testCwd = process.cwd();

  afterEach(() => {
    process.chdir(testCwd);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function createAppBuilder(appRoot: string) {
    return createBuilder({
      root: appRoot,
      cacheDir: testCacheDir(appRoot),
      configFile: false,
      plugins: [vinext({ appDir: appRoot })],
      logLevel: "silent",
      // Run the lifecycle the `vinext build` CLI enables.
      [VINEXT_BUILD_LIFECYCLE_CONFIG]: {},
    } as InlineConfig);
  }

  it("fails with the install command instead of upgrading React", async () => {
    root = createAppWithReact("19.2.7");
    const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf-8");

    await expect(createAppBuilder(root)).rejects.toThrow(
      "vinext: App Router requires react, react-dom, and react-server-dom-webpack 19.3.1 or later.\n" +
        "Run: npm install react@latest react-dom@latest",
    );
    expect(fs.readFileSync(path.join(root, "package.json"), "utf-8")).toBe(packageJson);
    expect(
      fs.readFileSync(path.join(root, "node_modules", "react", "package.json"), "utf-8"),
    ).toContain('"version":"19.2.7"');
  });

  it("accepts React at the floor", async () => {
    root = createAppWithReact("19.3.1");
    await expect(createAppBuilder(root)).resolves.toBeDefined();
  });
});
