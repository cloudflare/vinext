import { describe, expect, it } from "vite-plus/test";
import {
  collectAsyncModules,
  hasTopLevelAwait,
} from "../packages/vinext/src/build/client-reference-async.js";

describe("hasTopLevelAwait", () => {
  it.each([
    ["await init();", true],
    ["if (typeof window === 'undefined') { await new Promise((r) => setTimeout(r, 1)); }", true],
    ["for await (const chunk of stream) {}", true],
    ["await using handle = open();", true],
    ["export const value = (await import('./data.js')).default;", true],
  ])("finds the top-level await in %s", (code, expected) => {
    expect(hasTopLevelAwait(code)).toBe(expected);
  });

  it.each([
    "export async function load() { await fetch('/'); }",
    "export const load = async () => { await fetch('/'); };",
    "class Store { async load() { await fetch('/'); } }",
    "const label = 'await';",
    "this is not javascript await",
  ])("treats %s as synchronous", (code) => {
    expect(hasTopLevelAwait(code)).toBe(false);
  });
});

describe("collectAsyncModules", () => {
  const graph: Record<string, { code: string; importedIds: string[] }> = {
    "/direct.tsx": { code: "await init();", importedIds: [] },
    "/importer.tsx": { code: "export {};", importedIds: ["/lib/a.ts"] },
    "/lib/a.ts": { code: "export {};", importedIds: ["/lib/b.ts"] },
    "/lib/b.ts": { code: "await setup();", importedIds: [] },
    "/sync.tsx": { code: "export async function f() { await g(); }", importedIds: ["/cycle.ts"] },
    "/cycle.ts": { code: "export {};", importedIds: ["/sync.tsx"] },
  };
  const getModuleInfo = (id: string) => graph[id] ?? null;

  it("marks roots that await at the top level or import a module that does", () => {
    const roots = ["/direct.tsx", "/importer.tsx", "/sync.tsx", "/external"];

    expect(collectAsyncModules({ roots, getModuleInfo })).toEqual(
      new Set(["/direct.tsx", "/importer.tsx"]),
    );
  });
});
