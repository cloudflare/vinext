/**
 * Ported from Next.js: test/e2e/app-dir/typeof-window/typeof-window.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/typeof-window/typeof-window.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  getTypeofWindowReplacement,
  replaceTypeofWindow,
} from "../packages/vinext/src/plugins/typeof-window.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("typeof window compilation", () => {
  it("only folds references to the global window binding", () => {
    const source = `
if (typeof window !== "undefined") globalBrowserOnly()
function check(window) {
  if (typeof window !== "undefined") localWindowOnly()
}
function hoisted() {
  console.log(typeof window)
  if (false) var window
}
{
  const window = {}
  console.log(typeof window)
}
export function exported(window) {
  return typeof window
}
const WindowClass = class window {
  check() { return typeof window }
}
switch (value) {
  case 1:
    const window = {}
    console.log(typeof window)
}`;

    const result = replaceTypeofWindow(source, "undefined");

    expect(result?.code).toContain(";");
    expect(result?.code).toContain('if (typeof window !== "undefined") localWindowOnly()');
    expect(result?.code.match(/typeof window/g)).toHaveLength(6);
  });

  it("removes nested dead branches in the selected branch", () => {
    const result = replaceTypeofWindow(
      `if (typeof window === "undefined") {
  if (typeof window !== "undefined") import("browser-only")
  serverOnly()
}`,
      "undefined",
    );

    expect(result?.code).not.toContain("browser-only");
    expect(result?.code).toContain("serverOnly()");
  });

  it("keeps function body var bindings out of default parameter scope", () => {
    const result = replaceTypeofWindow(
      `function load(value = typeof window !== "undefined" ? import("browser-only") : null) {
  var window
  return value
}`,
      "undefined",
    );

    expect(result?.code).not.toContain("browser-only");
    expect(result?.code).toContain("value = (null)");
    expect(result?.code).toContain("var window");
  });

  it("preserves selected conditional expression precedence", () => {
    const result = replaceTypeofWindow(
      `const value = typeof window === "undefined" ? (serverValue, fallbackValue) : browserValue`,
      "undefined",
    );

    expect(result?.code).toBe("const value = (serverValue, fallbackValue)");
  });

  it("uses the resolved environment consumer for custom client environments", () => {
    expect(getTypeofWindowReplacement({ config: { consumer: "client" } })).toBe("object");
    expect(getTypeofWindowReplacement({ config: { consumer: "server" } })).toBe("undefined");
  });

  it("removes browser-only dynamic imports from server bundles", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-typeof-window-"));
    temporaryDirectories.push(root);

    await fs.mkdir(path.join(root, "app"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules", "my-differentiated-files"), {
      recursive: true,
    });
    const workspaceNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    for (const packageName of ["react", "react-dom"]) {
      await fs.symlink(
        path.join(workspaceNodeModules, packageName),
        path.join(root, "node_modules", packageName),
        "junction",
      );
    }
    await fs.writeFile(
      path.join(root, "app", "layout.jsx"),
      `export default function Root({ children }) { return <html><body>{children}</body></html> }`,
    );
    await fs.writeFile(
      path.join(root, "app", "page.jsx"),
      `'use client'
if (typeof window !== 'undefined') {
  import('my-differentiated-files/browser').then((mod) => console.log(mod.default))
}
function load(value = typeof window !== 'undefined' ? import('my-differentiated-files/browser') : null) {
  var window
  return value
}
load()
export default function Page() { return <h1>Page loaded</h1> }`,
    );
    await fs.writeFile(
      path.join(root, "node_modules", "my-differentiated-files", "package.json"),
      JSON.stringify({
        name: "my-differentiated-files",
        version: "1.0.0",
        type: "module",
        exports: {
          "./browser": { browser: "./browser.js", node: null },
        },
      }),
    );
    await fs.writeFile(
      path.join(root, "node_modules", "my-differentiated-files", "browser.js"),
      `export default "BROWSER"`,
    );

    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ appDir: root })],
    });

    await expect(builder.buildApp()).resolves.toBeUndefined();

    const ssrFiles = await fs.readdir(path.join(root, "dist", "server", "ssr"), {
      recursive: true,
    });
    const ssrJavaScript = await Promise.all(
      ssrFiles
        .filter((file) => typeof file === "string" && /\.[cm]?js$/.test(file))
        .map((file) => fs.readFile(path.join(root, "dist", "server", "ssr", file), "utf8")),
    );
    expect(ssrJavaScript.join("\n")).not.toContain("my-differentiated-files");

    const clientFiles = await fs.readdir(path.join(root, "dist", "client"), { recursive: true });
    const clientJavaScript = await Promise.all(
      clientFiles
        .filter((file) => typeof file === "string" && /\.[cm]?js$/.test(file))
        .map((file) => fs.readFile(path.join(root, "dist", "client", file), "utf8")),
    );
    expect(clientJavaScript.join("\n")).toContain("BROWSER");
  }, 30000);
});
