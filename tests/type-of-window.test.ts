/**
 * Ported from Next.js: test/e2e/app-dir/typeof-window/typeof-window.test.ts
 * https://github.com/vercel/next.js/blob/v16.2.6/test/e2e/app-dir/typeof-window/typeof-window.test.ts
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createBuilder, parseAst } from "vite";
import vinext from "../packages/vinext/src/index.js";
import {
  consumerEnvironmentConditionFilter,
  getTypeofWindowReplacement,
  replaceConsumerEnvironmentConditions,
  replaceTypeofWindow,
} from "../packages/vinext/src/plugins/typeof-window.js";
import { supportsNativeTypeofWindowFolding } from "../packages/vinext/src/utils/vite-version.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("typeof window compilation", () => {
  it("configures the installed Vite typeof window folding strategy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-typeof-window-define-"));
    temporaryDirectories.push(root);
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      environments: {
        server: { consumer: "server" },
      },
      plugins: [vinext({ react: false, rsc: false })],
    });

    const vitePackage = (await import("vite/package.json", { with: { type: "json" } })).default;
    const viteVersion = vitePackage.bundledVersions?.vite ?? (await import("vite")).version;
    const usesNativeFolding = supportsNativeTypeofWindowFolding(
      viteVersion,
      vitePackage.bundledVersions?.rolldown,
    );

    expect(builder.environments.client?.config.define?.["typeof window"]).toBe(
      usesNativeFolding ? '"object"' : undefined,
    );
    expect(builder.environments.server?.config.define?.["typeof window"]).toBe(
      usesNativeFolding ? '"undefined"' : undefined,
    );
  });

  it("filters unrelated process references before invoking JavaScript", () => {
    const lineContinuation = 'process["brow' + "\\" + '\nser"]';
    const identityEscape = String.raw`process["brow\ser"]`;
    expect(consumerEnvironmentConditionFilter.test("process.env.NODE_ENV")).toBe(false);
    expect(consumerEnvironmentConditionFilter.test("process /* comment */ . browser")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test("process. /* comment */ browser")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test('process["browser"]')).toBe(true);
    expect(consumerEnvironmentConditionFilter.test('process?.["browser"]')).toBe(true);
    expect(consumerEnvironmentConditionFilter.test('process?. ["browser"]')).toBe(true);
    expect(consumerEnvironmentConditionFilter.test('process?. [("browser")]')).toBe(true);
    expect(consumerEnvironmentConditionFilter.test("(process).browser")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test("browser && process.browser")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test("process.brow\\u0073er")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test("proce\\u0073s.browser")).toBe(true);
    expect(consumerEnvironmentConditionFilter.test(lineContinuation)).toBe(true);
    expect(consumerEnvironmentConditionFilter.test(identityEscape)).toBe(true);
    expect(
      consumerEnvironmentConditionFilter.test("const process = {}; const browser = true"),
    ).toBe(false);
  });

  it("folds computed process.browser escape and optional-chain spellings", () => {
    for (const member of [
      'process["brow' + "\\" + '\nser"]',
      String.raw`process["brow\ser"]`,
      'process?. [("browser")]',
    ]) {
      const result = replaceConsumerEnvironmentConditions(`if (${member}) import("browser-only")`, {
        processBrowser: false,
        pruneUnreachableImports: true,
      });

      expect(result?.code, member).not.toContain("browser-only");
    }
  });

  it("filters large one-sided sources in linear time", () => {
    const sources = [
      "process.env.NODE_ENV; ".repeat(40_000),
      "browser; ".repeat(100_000),
      `process${" ".repeat(1_000_000)}`,
      `process["${"a".repeat(1_000_000)}`,
    ];
    const start = performance.now();
    const matches = sources.map((source) => consumerEnvironmentConditionFilter.test(source));
    const elapsed = performance.now() - start;

    expect(matches).toEqual([false, false, false, false]);
    expect(elapsed).toBeLessThan(500);
  });

  it("uses native folding only from the stable Vite 8.1.4 release", () => {
    expect(supportsNativeTypeofWindowFolding("8.1.3")).toBe(false);
    expect(supportsNativeTypeofWindowFolding("8.1.4-beta.1")).toBe(false);
    expect(supportsNativeTypeofWindowFolding("8.1.4")).toBe(true);
    expect(supportsNativeTypeofWindowFolding("8.1.4+build.1")).toBe(true);
    expect(supportsNativeTypeofWindowFolding("8.2.0-beta.1")).toBe(true);
    expect(supportsNativeTypeofWindowFolding("9.0.0-beta.1")).toBe(true);
    expect(supportsNativeTypeofWindowFolding("8.1.2", "1.1.3")).toBe(false);
    expect(supportsNativeTypeofWindowFolding("8.1.2", "1.1.4-beta.1")).toBe(false);
    expect(supportsNativeTypeofWindowFolding("8.1.2", "1.1.4")).toBe(true);
    expect(supportsNativeTypeofWindowFolding("8.2.0", "1.1.3")).toBe(false);
  });

  it("skips custom scan folding for modules in the Vite cache directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-typeof-window-cache-"));
    temporaryDirectories.push(root);
    const cacheDir = path.join(root, ".vite-cache[custom]");
    const builder = await createBuilder({
      root,
      cacheDir,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ react: false, rsc: false })],
    });
    const plugin = builder.config.plugins.find(
      (candidate) => candidate.name === "vinext:typeof-window-scan",
    );
    if (!plugin?.transform || typeof plugin.transform === "function") {
      throw new Error("vinext:typeof-window-scan transform hook not found");
    }

    const transform = plugin.transform.handler;
    const context = {
      environment: {
        config: {
          build: { write: false },
          cacheDir,
          consumer: "server",
        },
      },
    };
    const source = `if (typeof window !== "undefined") import("browser-only")`;
    const appPageId = path.join(root, "app/page.js");

    expect(
      await transform.call(context as never, source, path.join(cacheDir, "deps_ssr/react.js")),
    ).toBeNull();
    const cachedServerResult = await transform.call(context as never, source, appPageId);
    expect(cachedServerResult).not.toBeNull();
    expect(await transform.call(context as never, source, appPageId)).toBe(cachedServerResult);

    const clientContext = {
      environment: {
        config: {
          ...context.environment.config,
          consumer: "client",
        },
      },
    };
    const clientResult = await transform.call(clientContext as never, source, appPageId);
    expect(clientResult).not.toBe(cachedServerResult);
    expect(await transform.call(clientContext as never, source, appPageId)).toBe(clientResult);
    expect(clientResult).toMatchObject({ code: expect.stringContaining("browser-only") });
    expect(
      await transform.call(context as never, `${source}\nconsole.log("changed")`, appPageId),
    ).not.toBe(cachedServerResult);
  });

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

  it("removes process.browser imports before server dependency analysis", () => {
    const result = replaceConsumerEnvironmentConditions(
      `if (process.browser) import("browser-only")
if (process.browser && enabled) import("compound-browser-only")
if (enabled && process.browser) import("reversed-browser-only")
if (process?.browser) import("optional-browser-only")
if (process["browser"]) import("computed-browser-only")
if (process.brow\\u0073er) import("escaped-property-browser-only")
if (process["brow\\u0073er"]) import("escaped-computed-browser-only")
if (proce\\u0073s.browser) import("escaped-process-browser-only")
if (process?.["browser"]) import("optional-computed-browser-only")
if (process /* comment */ . browser) import("commented-browser-only")
if (!process.browser) serverOnly()
process.browser && enabled && import("also-browser-only")
import("preserved-effect") && process.browser && import("effect-browser-only")
if ((function () {}) && process.browser) import("anonymous-effect-browser-only")
if (effect() && process.browser) primary(); else if (process.browser) import("nested-browser-only")
const nested = effect() && process.browser ? primary() : process.browser ? import("nested-expression-browser-only") : fallback()
const selected = process.browser === false ? "server" : "browser"`,
      { processBrowser: false, pruneUnreachableImports: true },
    );

    expect(result?.code).not.toContain("browser-only");
    expect(result?.code).not.toContain("compound-browser-only");
    expect(result?.code).not.toContain("reversed-browser-only");
    expect(result?.code).not.toContain("optional-browser-only");
    expect(result?.code).not.toContain("computed-browser-only");
    expect(result?.code).not.toContain("escaped-property-browser-only");
    expect(result?.code).not.toContain("escaped-computed-browser-only");
    expect(result?.code).not.toContain("escaped-process-browser-only");
    expect(result?.code).not.toContain("optional-computed-browser-only");
    expect(result?.code).not.toContain("commented-browser-only");
    expect(result?.code).not.toContain("effect-browser-only");
    expect(result?.code).not.toContain("anonymous-effect-browser-only");
    expect(result?.code).not.toContain("nested-browser-only");
    expect(result?.code).not.toContain("nested-expression-browser-only");
    expect(result?.code).toContain('import("preserved-effect")');
    expect(result?.code).toContain("function () {}");
    expect(result?.code).toContain("fallback()");
    expect(() => parseAst(result?.code ?? "")).not.toThrow();
    expect(result?.code).not.toContain("also-browser-only");
    expect(result?.code).toContain("serverOnly()");
    expect(result?.code).toContain('const selected = ("server")');
    expect(result?.code).not.toContain("process.browser");
  });

  it("preserves logical operand values outside import analysis", () => {
    const source = `const falsy = value && typeof window === "object";
const truthy = value || typeof window === "undefined";`;
    const result = replaceTypeofWindow(source, "undefined");

    expect(result?.code).toContain('value && "undefined" === "object"');
    expect(result?.code).toContain('value || "undefined" === "undefined"');
  });

  it("skips unrelated process references during import analysis", () => {
    expect(
      replaceConsumerEnvironmentConditions(
        `console.log(process.env.NODE_ENV)`,
        { processBrowser: false, pruneUnreachableImports: true },
        "example.js",
      ),
    ).toBeNull();
  });

  it("preserves locally bound process.browser references", () => {
    const result = replaceConsumerEnvironmentConditions(
      `if (process.browser) globalBrowserOnly()
function check(process) {
  if (process.browser) localBrowserOnly()
}
{
  const process = { browser: true }
  console.log(process.browser)
}`,
      { processBrowser: false },
    );

    expect(result?.code).not.toContain("globalBrowserOnly");
    expect(result?.code).toContain("if (process.browser) localBrowserOnly()");
    expect(result?.code).toContain("console.log(process.browser)");
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

  it("preserves window bindings declared in loop headers", () => {
    const result = replaceTypeofWindow(
      `for (const window of windows) console.log(typeof window)
for (let window; condition; ) console.log(typeof window)`,
      "undefined",
    );

    expect(result).toBeNull();
  });

  it("keeps switch-case bindings out of the discriminant scope", () => {
    const result = replaceTypeofWindow(
      `switch (typeof window) {
  case typeof window:
    let window
    console.log(typeof window)
}`,
      "undefined",
    );

    expect(result?.code).toContain('switch ("undefined")');
    expect(result?.code.match(/typeof window/g)).toHaveLength(2);
  });

  it("contains var window bindings in TypeScript namespaces and static blocks", () => {
    const result = replaceTypeofWindow(
      `namespace Loader {
  if (condition) var window
  console.log(typeof window)
}
class BrowserLoader {
  static {
    if (condition) var window
    console.log(typeof window)
  }
}
console.log(typeof window)`,
      "undefined",
      "/app/page.ts",
    );

    expect(result?.code.match(/typeof window/g)).toHaveLength(2);
    expect(result?.code).toContain('console.log("undefined")');
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
        .filter(
          (file) =>
            typeof file === "string" &&
            /\.[cm]?js$/.test(file) &&
            path.basename(file) !== "vinext-client-assets.js",
        )
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
