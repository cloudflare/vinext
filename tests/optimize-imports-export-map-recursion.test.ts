import { describe, it, expect } from "vite-plus/test";
import { buildBarrelExportMap } from "../packages/vinext/src/plugins/optimize-imports.js";

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("buildBarrelExportMap recursive and edge cases", () => {
  it("handles circular wildcard re-exports without infinite loop", async () => {
    const entryPath = "/fake/circular/a.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./b";\nexport { A } from "./a-impl";`,
      "/fake/circular/b.js": `export * from "./a";\nexport { B } from "./b-impl";`,
    };
    await expect(
      buildBarrelExportMap(
        "test-pkg",
        () => entryPath,
        (fp) => Promise.resolve(files[fp] ?? null),
      ),
    ).resolves.not.toThrow();
  });

  it("resolves wildcard export * from './mod' where mod.jsx exists (jsx extension)", async () => {
    const entryPath = "/fake/jsx-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./Button";`,
      "/fake/jsx-wildcard/Button.jsx": `export { Button } from "./button-impl";`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    expect(map!.has("Button")).toBe(true);
  });

  it("resolves wildcard export * from './mod' where mod.cjs exists (cjs extension)", async () => {
    const entryPath = "/fake/cjs-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./helpers";`,
      "/fake/cjs-wildcard/helpers.cjs": `exports.helper = function helper() {};`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
  });

  it("skips malformed AST nodes without crashing (astName returns null gracefully)", async () => {
    const entryPath = uniquePath("malformed-ast");
    const barrelCode = `export { Button } from "./button";`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.has("Button")).toBe(true);
  });

  it("resolves export function declaration in sub-module (date-fns style)", async () => {
    const entryPath = "/fake/date-fns/index.js";
    const subPath = "/fake/date-fns/formatDistanceToNow.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./formatDistanceToNow.js";`,
      [subPath]: `export function formatDistanceToNow(date, options) { return date; }`,
    };
    const map = await buildBarrelExportMap(
      "date-fns",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    const entry = map!.get("formatDistanceToNow");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe(subPath);
    expect(entry!.isNamespace).toBe(false);
  });

  it("resolves multiple export const declarations in a single VariableDeclaration", async () => {
    const entryPath = "/fake/multi-const/index.js";
    const subPath = "/fake/multi-const/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./utils.js";`,
      [subPath]: `export const add = (a, b) => a + b, subtract = (a, b) => a - b;`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    expect(map!.get("add")).toMatchObject({ source: subPath, isNamespace: false });
    expect(map!.get("subtract")).toMatchObject({ source: subPath, isNamespace: false });
  });

  it("resolves export class declaration in sub-module", async () => {
    const entryPath = "/fake/class-export/index.js";
    const subPath = "/fake/class-export/MyClass.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./MyClass.js";`,
      [subPath]: `export class MyClass {}`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    expect(map!.get("MyClass")).toMatchObject({ source: subPath, isNamespace: false });
  });
});
