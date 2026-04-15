import { describe, it, expect } from "vite-plus/test";
import * as path from "node:path";
import { buildBarrelExportMap } from "../packages/vinext/src/plugins/optimize-imports.js";

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("buildBarrelExportMap direct re-export cases", () => {
  it("handles export * as Name from 'sub-pkg'", async () => {
    const entryPath = uniquePath("namespace-reexport");
    const barrelCode = `export * as Slot from "@radix-ui/react-slot";\nexport * as Tooltip from "@radix-ui/react-tooltip";`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("Slot")).toEqual({ source: "@radix-ui/react-slot", isNamespace: true });
    expect(map!.get("Tooltip")).toEqual({ source: "@radix-ui/react-tooltip", isNamespace: true });
  });

  it("handles export { A, B } from 'sub-pkg'", async () => {
    const entryPath = uniquePath("named-reexport");
    const entryDir = path.dirname(entryPath);
    const barrelCode = `export { Button, buttonVariants } from "./button";\nexport { Input } from "./input";`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("Button")).toEqual({
      source: path.resolve(entryDir, "./button").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "Button",
    });
    expect(map!.get("buttonVariants")).toEqual({
      source: path.resolve(entryDir, "./button").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "buttonVariants",
    });
    expect(map!.get("Input")).toEqual({
      source: path.resolve(entryDir, "./input").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "Input",
    });
  });

  it("handles export { default as Name } from 'sub-pkg'", async () => {
    const entryPath = uniquePath("default-reexport");
    const entryDir = path.dirname(entryPath);
    const barrelCode = `export { default as Calendar } from "./calendar";`;
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(barrelCode),
    );
    expect(map).not.toBeNull();
    expect(map!.get("Calendar")).toEqual({
      source: path.resolve(entryDir, "./calendar").split(path.sep).join("/"),
      isNamespace: false,
      originalName: "default",
    });
  });
});
