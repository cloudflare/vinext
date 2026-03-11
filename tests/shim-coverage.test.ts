import { describe, it, expect } from "vitest";
import {
  extractExports,
  checkModuleCoverage,
  type KnownGaps,
} from "../packages/vinext/src/shims/coverage";

describe("extractExports", () => {
  it("parses function, const, class, and default exports", () => {
    const source = `
      export function foo() {}
      export const bar = 1;
      export class Baz {}
      export default function() {}
    `;
    const { runtime } = extractExports(source);
    expect(runtime).toEqual(new Set(["foo", "bar", "Baz", "default"]));
  });

  it("handles re-exports with as clauses", () => {
    const source = `export { X, Y as Z }`;
    const { runtime } = extractExports(source);
    expect(runtime).toEqual(new Set(["X", "Z"]));
  });

  it("handles async functions and enums", () => {
    const source = `
      export async function fetchData() {}
      export enum Color { Red, Green }
    `;
    const { runtime } = extractExports(source);
    expect(runtime).toEqual(new Set(["fetchData", "Color"]));
  });

  it("separates type exports from runtime exports", () => {
    const source = `
      export type Foo = string;
      export interface Bar { x: number; }
      export function baz() {}
      export { type Qux } from './other';
    `;
    const { runtime, types } = extractExports(source);
    expect(runtime).toEqual(new Set(["baz"]));
    expect(types).toContain("Foo");
    expect(types).toContain("Bar");
  });

  it("handles let and var exports", () => {
    const source = `
      export let mutableValue = 0;
      export var legacyValue = "hello";
    `;
    const { runtime } = extractExports(source);
    expect(runtime).toEqual(new Set(["mutableValue", "legacyValue"]));
  });
});

describe("checkModuleCoverage", () => {
  const makeManifest = (modules: Record<string, string[]>) => ({
    modules,
  });

  it("passes when all exports are covered", () => {
    const manifest = makeManifest({
      "next/headers": ["cookies", "headers"],
    });
    const registry = new Set(["next/headers"]);
    const shimExports = {
      "next/headers": new Set(["cookies", "headers"]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    expect(result.passed).toBe(true);
    expect(result.coveredModules).toEqual(["next/headers"]);
  });

  it("fails when export missing from shim", () => {
    const manifest = makeManifest({
      "next/headers": ["cookies", "headers", "draftMode"],
    });
    const registry = new Set(["next/headers"]);
    const shimExports = {
      "next/headers": new Set(["cookies", "headers"]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    expect(result.passed).toBe(false);
    expect(result.missingExports["next/headers"]).toEqual(["draftMode"]);
  });

  it("respects wildcard known-gaps", () => {
    const manifest = makeManifest({ "next/jest": ["default"] });
    const gaps: KnownGaps = {
      "next/jest": { exports: ["*"], status: "wont-fix", reason: "test" },
    };
    const result = checkModuleCoverage(manifest, new Set(), {}, gaps);
    expect(result.passed).toBe(true);
    expect(result.gappedModules).toEqual(["next/jest"]);
  });

  it("reports missing module when not in registry or gaps", () => {
    const manifest = makeManifest({ "next/unknown": ["foo"] });
    const result = checkModuleCoverage(manifest, new Set(), {}, {});
    expect(result.passed).toBe(false);
    expect(result.missingModules).toEqual(["next/unknown"]);
  });

  it("respects per-export known-gaps", () => {
    const manifest = makeManifest({
      "next/amp": ["useAmp", "anotherExport"],
    });
    const registry = new Set(["next/amp"]);
    const shimExports = { "next/amp": new Set(["useAmp"]) };
    const gaps: KnownGaps = {
      "next/amp": {
        exports: ["anotherExport"],
        status: "stub",
        reason: "test",
      },
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, gaps);
    expect(result.passed).toBe(true);
  });

  it("skips __esModule but checks default in export checks", () => {
    const manifest = makeManifest({
      "next/headers": ["__esModule", "default", "cookies"],
    });
    const registry = new Set(["next/headers"]);
    const shimExports = {
      "next/headers": new Set(["cookies"]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    // Should fail because "default" is not in shimExports
    expect(result.passed).toBe(false);
    expect(result.missingExports["next/headers"]).toEqual(["default"]);
  });

  it("passes when default export is present in shim", () => {
    const manifest = makeManifest({
      "next/form": ["__esModule", "default"],
    });
    const registry = new Set(["next/form"]);
    const shimExports = {
      "next/form": new Set(["default"]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    expect(result.passed).toBe(true);
    expect(result.coveredModules).toEqual(["next/form"]);
  });

  it("catches missing default export", () => {
    const manifest = makeManifest({
      "next/error": ["default"],
    });
    const registry = new Set(["next/error"]);
    const shimExports = {
      "next/error": new Set([]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    expect(result.passed).toBe(false);
    expect(result.missingExports["next/error"]).toEqual(["default"]);
  });

  it("handles multiple modules with mixed coverage", () => {
    const manifest = makeManifest({
      "next/headers": ["cookies", "headers"],
      "next/cache": ["revalidateTag", "missingFn"],
      "next/jest": ["default"],
    });
    const registry = new Set(["next/headers", "next/cache"]);
    const shimExports = {
      "next/headers": new Set(["cookies", "headers"]),
      "next/cache": new Set(["revalidateTag"]),
    };
    const gaps: KnownGaps = {
      "next/jest": { exports: ["*"], status: "wont-fix", reason: "test" },
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, gaps);
    expect(result.passed).toBe(false);
    expect(result.coveredModules).toEqual(["next/headers"]);
    expect(result.gappedModules).toEqual(["next/jest"]);
    expect(result.missingExports["next/cache"]).toEqual(["missingFn"]);
  });

  it("combines per-export gaps with shim exports for full coverage", () => {
    const manifest = makeManifest({
      "next/navigation": ["useRouter", "redirect", "unstable_rethrow"],
    });
    const registry = new Set(["next/navigation"]);
    const shimExports = {
      "next/navigation": new Set(["useRouter", "redirect"]),
    };
    const gaps: KnownGaps = {
      "next/navigation": {
        exports: ["unstable_rethrow"],
        status: "planned",
        reason: "Not yet implemented",
      },
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, gaps);
    expect(result.passed).toBe(true);
    expect(result.coveredModules).toEqual(["next/navigation"]);
  });

  it("ignores registry-only shims that are outside the current manifest", () => {
    const manifest = makeManifest({
      "next/headers": ["cookies"],
    });
    const registry = new Set(["next/headers", "next/config"]);
    const shimExports = {
      "next/headers": new Set(["cookies"]),
      "next/config": new Set(["default"]),
    };
    const result = checkModuleCoverage(manifest, registry, shimExports, {});
    expect(result.passed).toBe(true);
    expect(result.coveredModules).toEqual(["next/headers"]);
    expect(result.missingModules).toEqual([]);
  });
});
