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
    // Imports a top-level-await module only for a name it never uses.
    "/shaken.tsx": { code: "export {};", importedIds: ["/lib/unused.ts"] },
    "/lib/unused.ts": { code: "await setup();", importedIds: [] },
    // Imports one that another chunk keeps, but its own chunk doesn't load.
    "/dropped.tsx": { code: "export {};", importedIds: ["/lib/elsewhere.ts"] },
    "/lib/elsewhere.ts": { code: "await setup();", importedIds: [] },
    "/elsewhere-user.tsx": { code: "export {};", importedIds: ["/lib/elsewhere.ts"] },
  };
  const getModuleInfo = (id: string) => graph[id] ?? null;
  const rendered = (...ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, { code: graph[id]!.code, renderedLength: 1 }]));
  const chunks = [
    { fileName: "direct.js", imports: [], modules: rendered("/direct.tsx") },
    {
      fileName: "importer.js",
      imports: ["lib.js"],
      modules: rendered("/importer.tsx", "/lib/a.ts"),
    },
    { fileName: "lib.js", imports: ["node:fs"], modules: rendered("/lib/b.ts") },
    { fileName: "sync.js", imports: [], modules: rendered("/sync.tsx", "/cycle.ts") },
    {
      fileName: "shaken.js",
      imports: [],
      modules: {
        ...rendered("/shaken.tsx"),
        "/lib/unused.ts": { code: "", renderedLength: 0 },
      },
    },
    { fileName: "dropped.js", imports: [], modules: rendered("/dropped.tsx") },
    { fileName: "elsewhere.js", imports: [], modules: rendered("/lib/elsewhere.ts") },
    {
      fileName: "elsewhere-user.js",
      imports: ["elsewhere.js"],
      modules: rendered("/elsewhere-user.tsx"),
    },
  ];

  it("marks roots that await at the top level or import a module that does", () => {
    const roots = ["/direct.tsx", "/importer.tsx", "/sync.tsx", "/external", "/elsewhere-user.tsx"];

    expect(collectAsyncModules({ roots, getModuleInfo, chunks })).toEqual(
      new Set(["/direct.tsx", "/importer.tsx", "/elsewhere-user.tsx"]),
    );
  });

  it("ignores imports the emitted output dropped", () => {
    const roots = ["/shaken.tsx", "/dropped.tsx"];

    expect(collectAsyncModules({ roots, getModuleInfo, chunks })).toEqual(new Set());
  });

  it("reads the code the output keeps", () => {
    const keptChunks = [
      {
        fileName: "direct.js",
        imports: [],
        modules: { "/direct.tsx": { code: "init();", renderedLength: 7 } },
      },
    ];

    expect(
      collectAsyncModules({ roots: ["/direct.tsx"], getModuleInfo, chunks: keptChunks }),
    ).toEqual(new Set());
  });
});
