import { describe, expect, it, vi } from "vite-plus/test";
import {
  magicStringTransformResult,
  omitUnusedBuildSourcemap,
  serverReferenceProxyResult,
} from "../packages/vinext/src/plugins/transform-result.js";

function createResult() {
  const generateMap = vi.fn(() => ({ version: 3, mappings: "AAAA" }));
  const output = {
    toString: () => 'const value = "undefined";',
    generateMap,
  } as unknown as Parameters<typeof magicStringTransformResult>[0];
  return { result: magicStringTransformResult(output), generateMap };
}

describe("magicStringTransformResult", () => {
  it("generates the sourcemap once, on first read", () => {
    const { result, generateMap } = createResult();

    expect(result.code).toBe('const value = "undefined";');
    expect(generateMap).not.toHaveBeenCalled();

    const map = result.map;
    expect(map).toEqual({ version: 3, mappings: "AAAA" });
    expect(result.map).toBe(map);
    expect(generateMap).toHaveBeenCalledOnce();
    expect(generateMap).toHaveBeenCalledWith({ hires: "boundary" });
  });
});

describe("serverReferenceProxyResult", () => {
  it("returns an empty map in builds without generating one", () => {
    const generateMap = vi.fn(() => ({ version: 3, mappings: "AAAA" }));
    const output = { toString: () => "export const action = proxy;", generateMap };

    expect(serverReferenceProxyResult({ mode: "build" }, output)).toEqual({
      code: "export const action = proxy;",
      map: { mappings: "" },
    });
    expect(generateMap).not.toHaveBeenCalled();
  });

  it("keeps the full map in dev", () => {
    const generateMap = vi.fn(() => ({ version: 3, sources: ["actions.ts"], mappings: "AAAA" }));
    const output = { toString: () => "export const action = proxy;", generateMap };

    const result = serverReferenceProxyResult({ mode: "dev" }, output, {
      hires: "boundary",
      source: "actions.ts",
    });
    expect(result.code).toBe("export const action = proxy;");
    expect(result.map).toEqual({ version: 3, sources: ["actions.ts"], mappings: "AAAA" });
    expect(generateMap).toHaveBeenCalledWith({ hires: "boundary", source: "actions.ts" });
  });
});

describe("omitUnusedBuildSourcemap", () => {
  it("drops the sourcemap without generating it when builds discard sourcemaps", () => {
    const { result, generateMap } = createResult();

    expect(
      omitUnusedBuildSourcemap({ mode: "build", config: { build: { sourcemap: false } } }, result),
    ).toEqual({ code: result.code, map: null });
    expect(generateMap).not.toHaveBeenCalled();
  });

  it.each([
    ["dev", { mode: "dev", config: { build: { sourcemap: false } } }],
    ["build with sourcemaps", { mode: "build", config: { build: { sourcemap: true } } }],
    ["build with inline sourcemaps", { mode: "build", config: { build: { sourcemap: "inline" } } }],
    ["build with hidden sourcemaps", { mode: "build", config: { build: { sourcemap: "hidden" } } }],
    ["no environment", undefined],
  ] as const)("keeps the result unchanged for %s", (_, environment) => {
    const { result } = createResult();

    expect(omitUnusedBuildSourcemap(environment, result)).toBe(result);
  });

  it("passes through untransformed modules", () => {
    expect(
      omitUnusedBuildSourcemap({ mode: "build", config: { build: { sourcemap: false } } }, null),
    ).toBeNull();
  });
});
