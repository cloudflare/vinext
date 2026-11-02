import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createBuilder, type InlineConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { VINEXT_BUILD_LIFECYCLE_CONFIG } from "../packages/vinext/src/build/lifecycle.js";
import vinext from "../packages/vinext/src/index.js";
import { testCacheDir } from "./helpers.js";

// The workspace installs a plugin-rsc that vendors RSDW 19.3.1, so a test can
// report an older version to exercise the bundled-RSDW gate.
const pluginRsc = vi.hoisted(() => ({ version: undefined as string | undefined }));
vi.mock("../packages/vinext/src/utils/plugin-rsc-version.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/vinext/src/utils/plugin-rsc-version.js")>();
  return {
    ...actual,
    assertPluginRscVersion: (resolvedRscPath: string) =>
      pluginRsc.version ?? actual.assertPluginRscVersion(resolvedRscPath),
  };
});

const repoNodeModules = path.resolve(import.meta.dirname, "../node_modules");
// RSDW is a vinext dev dependency, so it is not linked at the repo root.
const repoRsdw = path.dirname(
  createRequire(path.resolve(import.meta.dirname, "../packages/vinext/package.json")).resolve(
    "react-server-dom-webpack/package.json",
  ),
);

function createAppWithReact(
  version: string,
  {
    declareRsdw = true,
    installRsdw = declareRsdw,
  }: { declareRsdw?: boolean; installRsdw?: boolean } = {},
): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-react-version-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "react-version-app",
      private: true,
      type: "module",
      packageManager: "npm@10.9.0",
      ...(declareRsdw && { dependencies: { "react-server-dom-webpack": "^19.3.1" } }),
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
  if (installRsdw) {
    fs.symlinkSync(repoRsdw, path.join(nodeModules, "react-server-dom-webpack"), "junction");
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
  // Loading next.config changes into the (mocked) cwd and back, so restore it.
  const testCwd = process.cwd();

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(testCwd);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    pluginRsc.version = undefined;
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

  it("requires an app RSDW while plugin-rsc bundles RSDW 19.3.0", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1", { declareRsdw: false });
    vi.spyOn(process, "cwd").mockReturnValue(root);

    await expect(createAppBuilder(root)).rejects.toThrow(
      "vinext: App Router requires react, react-dom, and react-server-dom-webpack 19.3.1 or later.\n" +
        "@vitejs/plugin-rsc 0.5.37 bundles an older react-server-dom-webpack, so install the latest in your app.\n" +
        "Run: npm install react-server-dom-webpack@latest",
    );
  });

  it("accepts an installed app RSDW while plugin-rsc bundles RSDW 19.3.0", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1");
    vi.spyOn(process, "cwd").mockReturnValue(root);
    await expect(createAppBuilder(root)).resolves.toBeDefined();
  });

  it("requires the declared app RSDW to be installed", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1", { installRsdw: false });
    vi.spyOn(process, "cwd").mockReturnValue(root);

    await expect(createAppBuilder(root)).rejects.toThrow(
      "Run: npm install react-server-dom-webpack@latest",
    );
  });

  it("checks the working directory plugin-rsc crawls, not the Vite root", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-react-version-cwd-"));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ name: "workspace" }));
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      await expect(createAppBuilder(root)).rejects.toThrow(
        "Run: npm install react-server-dom-webpack@latest",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("checks the package that owns the working directory", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1");
    const cwd = path.join(root, "app");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    await expect(createAppBuilder(root)).resolves.toBeDefined();
  });

  it("checks the RSDW version in the working directory plugin-rsc crawls", async () => {
    pluginRsc.version = "0.5.37";
    root = createAppWithReact("19.3.1");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-build-react-version-cwd-"));
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "workspace", dependencies: { "react-server-dom-webpack": "19.3.0" } }),
    );
    const rsdw = path.join(cwd, "node_modules", "react-server-dom-webpack");
    fs.mkdirSync(rsdw, { recursive: true });
    fs.writeFileSync(
      path.join(rsdw, "package.json"),
      JSON.stringify({ name: "react-server-dom-webpack", version: "19.3.0", main: "index.js" }),
    );
    fs.writeFileSync(path.join(rsdw, "index.js"), "module.exports = {};");
    vi.spyOn(process, "cwd").mockReturnValue(cwd);

    try {
      await expect(createAppBuilder(root)).rejects.toThrow(
        "Run: npm install react-server-dom-webpack@latest",
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("uses plugin-rsc's bundled RSDW once it is at the floor", async () => {
    root = createAppWithReact("19.3.1", { declareRsdw: false });
    await expect(createAppBuilder(root)).resolves.toBeDefined();
  });
});
