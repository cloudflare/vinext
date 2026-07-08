import fs, { globSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  importExportWithCommonJsFallback,
  loadCommonJsModule,
} from "../packages/vinext/src/utils/commonjs-loader.js";

const tempDirs: string[] = [];

function createEsmProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-commonjs-loader-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.chmodSync(dir, 0o755);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadCommonJsModule", () => {
  it("loads nested CommonJS .js files with circular dependencies", () => {
    const dir = createEsmProject();
    fs.writeFileSync(
      path.join(dir, "a.js"),
      `exports.name = "a";
const b = require("./b.js");
exports.fromB = b.name;
exports.seenByB = b.fromA;
`,
    );
    fs.writeFileSync(
      path.join(dir, "b.js"),
      `exports.name = "b";
const a = require("./a.js");
exports.fromA = a.name;
`,
    );

    expect(loadCommonJsModule(path.join(dir, "a.js"))).toEqual({
      name: "a",
      fromB: "b",
      seenByB: "a",
    });
  });

  it("keeps fallback active across CommonJS .cjs boundaries", () => {
    const dir = createEsmProject();
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `module.exports = require("./bridge.cjs");
`,
    );
    fs.writeFileSync(
      path.join(dir, "bridge.cjs"),
      `module.exports = require("./value.js");
`,
    );
    fs.writeFileSync(
      path.join(dir, "value.js"),
      `module.exports = { value: "nested" };
`,
    );

    expect(loadCommonJsModule(path.join(dir, "entry.js"))).toEqual({ value: "nested" });
  });

  it("preserves Node cache and parent semantics across CommonJS .cjs boundaries", () => {
    const dir = createEsmProject();
    const counterKey = `__vinext_commonjs_bridge_${Date.now()}`;
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `const first = require("./bridge.cjs");
const second = require("./bridge.cjs");
module.exports = { first, same: first === second };
`,
    );
    fs.writeFileSync(
      path.join(dir, "bridge.cjs"),
      `globalThis[${JSON.stringify(counterKey)}] = (globalThis[${JSON.stringify(counterKey)}] ?? 0) + 1;
module.exports = {
  cached: require.cache[__filename] === module,
  parent: module.parent?.filename,
};
`,
    );

    const result = loadCommonJsModule(path.join(dir, "entry.js")) as {
      first: { cached: boolean; parent?: string };
      same: boolean;
    };
    expect(result.first.cached).toBe(true);
    expect(result.first.parent).toBe(fs.realpathSync(path.join(dir, "entry.js")));
    expect(result.same).toBe(true);
    expect((globalThis as Record<string, unknown>)[counterKey]).toBe(1);
    delete (globalThis as Record<string, unknown>)[counterKey];
  });

  it("keeps fallback active for deferred exported function requires", () => {
    const dir = createEsmProject();
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `module.exports = () => require("./value.js");
`,
    );
    fs.writeFileSync(path.join(dir, "value.js"), `module.exports = "deferred";\n`);

    const loadValue = loadCommonJsModule(path.join(dir, "entry.js")) as () => string;
    expect(loadValue()).toBe("deferred");
  });

  it("keeps fallback active for deferred async exported function requires", async () => {
    const dir = createEsmProject();
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `module.exports = async () => require("./value.js");
`,
    );
    fs.writeFileSync(path.join(dir, "value.js"), `module.exports = "async-deferred";\n`);

    const loadValue = loadCommonJsModule(path.join(dir, "entry.js")) as () => Promise<string>;
    await expect(loadValue()).resolves.toBe("async-deferred");
  });

  it("delegates builtins and JSON files to Node's loader", () => {
    const dir = createEsmProject();
    fs.writeFileSync(path.join(dir, "data.json"), JSON.stringify({ value: "json" }));
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `const path = require("node:path");
const data = require("./data.json");
module.exports = path.posix.join(data.value, "builtin");
`,
    );

    expect(loadCommonJsModule(path.join(dir, "entry.js"))).toBe("json/builtin");
  });

  it("delegates packages with native addons to Node's loader", () => {
    const dir = createEsmProject();
    const [addonPath] = globSync(
      "node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      { cwd: path.join(import.meta.dirname, "..") },
    );
    expect(addonPath).toBeDefined();
    const resolvedAddonPath = path.resolve(import.meta.dirname, "..", addonPath!);
    fs.writeFileSync(
      path.join(dir, "entry.js"),
      `const watcher = require(${JSON.stringify(resolvedAddonPath)});
module.exports = typeof watcher;
`,
    );

    expect(loadCommonJsModule(path.join(dir, "entry.js"))).toBe("object");
  });

  it("does not retry syntax errors as CommonJS", async () => {
    const dir = createEsmProject();
    const entryPath = path.join(dir, "entry.js");
    fs.writeFileSync(
      entryPath,
      `export default { invalid: };
`,
    );

    await expect(importExportWithCommonJsFallback(entryPath)).rejects.toThrow("Unexpected token");
  });

  it("does not retry user-thrown errors that mimic missing CommonJS globals", async () => {
    const dir = createEsmProject();
    const entryPath = path.join(dir, "entry.js");
    const counterKey = `__vinext_commonjs_loader_${Date.now()}`;
    fs.writeFileSync(
      entryPath,
      `globalThis[${JSON.stringify(counterKey)}] = (globalThis[${JSON.stringify(counterKey)}] ?? 0) + 1;
throw new ReferenceError("require is not defined in ES module scope");
`,
    );

    await expect(importExportWithCommonJsFallback(entryPath)).rejects.toThrow(
      "require is not defined in ES module scope",
    );
    expect((globalThis as Record<string, unknown>)[counterKey]).toBe(1);
    delete (globalThis as Record<string, unknown>)[counterKey];
  });

  it("does not retry user-thrown errors that spoof ERR_REQUIRE_ESM", async () => {
    const dir = createEsmProject();
    const entryPath = path.join(dir, "entry.js");
    const counterKey = `__vinext_commonjs_loader_code_${Date.now()}`;
    fs.writeFileSync(
      entryPath,
      `globalThis[${JSON.stringify(counterKey)}] = (globalThis[${JSON.stringify(counterKey)}] ?? 0) + 1;
const error = new Error("application failure");
error.code = "ERR_REQUIRE_ESM";
throw error;
`,
    );

    await expect(importExportWithCommonJsFallback(entryPath)).rejects.toThrow(
      "application failure",
    );
    expect((globalThis as Record<string, unknown>)[counterKey]).toBe(1);
    delete (globalThis as Record<string, unknown>)[counterKey];
  });

  it("preserves CommonJS exports that contain a default property", async () => {
    const dir = createEsmProject();
    const entryPath = path.join(dir, "entry.js");
    fs.writeFileSync(
      entryPath,
      `module.exports = { default: "value", named: true };
`,
    );

    await expect(importExportWithCommonJsFallback(entryPath)).resolves.toEqual({
      default: "value",
      named: true,
    });
  });
});
