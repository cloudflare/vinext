import { describe, it, expect } from "vite-plus/test";
import {
  buildBarrelExportMap,
  DEFAULT_OPTIMIZE_PACKAGES,
} from "../packages/vinext/src/plugins/optimize-imports.js";

let testId = 0;
function uniquePath(name: string): string {
  return `/fake/${name}-${++testId}/entry.js`;
}

describe("buildBarrelExportMap failure and baseline cases", () => {
  it("returns null when entry cannot be resolved", async () => {
    const map = await buildBarrelExportMap(
      "nonexistent-pkg",
      () => null,
      () => Promise.resolve(null),
    );
    expect(map).toBeNull();
  });

  it("returns null when entry file cannot be read", async () => {
    const entryPath = uniquePath("unreadable");
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve(null),
    );
    expect(map).toBeNull();
  });

  it("returns an empty map when entry file has syntax errors", async () => {
    const entryPath = uniquePath("syntax-error");
    const map = await buildBarrelExportMap(
      "test-pkg",
      () => entryPath,
      () => Promise.resolve("export { unclosed"),
    );
    expect(map).not.toBeNull();
    expect(map!.size).toBe(0);
  });

  it("DEFAULT_OPTIMIZE_PACKAGES includes expected packages", () => {
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("lucide-react");
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("radix-ui");
    expect(DEFAULT_OPTIMIZE_PACKAGES).toContain("antd");
  });
});
