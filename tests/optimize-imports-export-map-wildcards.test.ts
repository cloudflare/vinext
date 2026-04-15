import { describe, it, expect } from "vite-plus/test";
import { buildBarrelExportMap } from "../packages/vinext/src/plugins/optimize-imports.js";

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("buildBarrelExportMap wildcard cases", () => {
  it("resolves wildcard export * from './sub' by merging sub-module exports", async () => {
    const entryPath = "/fake/wildcard-test/index.js";
    const subPath = "/fake/wildcard-test/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./utils";\nexport { Button } from "./button";`,
      [subPath]: `export { format } from "./format";\nexport { parse } from "./parse";`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    expect(map!.get("Button")).toEqual({
      source: "/fake/wildcard-test/button",
      isNamespace: false,
      originalName: "Button",
    });
    expect(map!.get("format")).toBeDefined();
    expect(map!.get("parse")).toBeDefined();
  });

  it("does not overwrite existing exports when wildcard sub-module has same name", async () => {
    const entryPath = "/fake/wildcard-nooverwrite/index.js";
    const subPath = "/fake/wildcard-nooverwrite/utils.js";
    const files: Record<string, string> = {
      [entryPath]: `export { format } from "./explicit";\nexport * from "./utils";`,
      [subPath]: `export { format } from "./other-format";`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    expect(map!.get("format")).toEqual({
      source: "/fake/wildcard-nooverwrite/explicit",
      isNamespace: false,
      originalName: "format",
    });
  });

  it("does not resolve wildcard export * from 'sub-pkg' (external package)", async () => {
    const entryPath = uniquePath("wildcard");
    const barrelCode = `export * from "some-external-pkg";\nexport { Button } from "./button";`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.has("Button")).toBe(true);
  });

  it("resolves nested subdirectory wildcard re-exports to the correct absolute path", async () => {
    const entryPath = "/fake/nested/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./components/index.js";`,
      "/fake/nested/components/index.js": `export { Button } from "./Button";`,
      "/fake/nested/components/Button.js": `export function Button() {}`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    const buttonEntry = map!.get("Button");
    expect(buttonEntry).toBeDefined();
    expect(buttonEntry!.source).toBe("/fake/nested/components/Button.js");
    expect(buttonEntry!.source).not.toBe("/fake/nested/Button.js");
  });

  it("resolves wildcard export * from './components' where components/ is a directory with index.js", async () => {
    const entryPath = "/fake/dir-wildcard/index.js";
    const files: Record<string, string> = {
      [entryPath]: `export * from "./components";`,
      "/fake/dir-wildcard/components/index.js": `export { Button } from "./Button";`,
      "/fake/dir-wildcard/components/Button.js": `export function Button() {}`,
    };
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      (fp) => Promise.resolve(files[fp] ?? null),
    );
    expect(map).not.toBeNull();
    const buttonEntry = map!.get("Button");
    expect(buttonEntry).toBeDefined();
    expect(buttonEntry!.source).toBe("/fake/dir-wildcard/components/Button.js");
  });
});
