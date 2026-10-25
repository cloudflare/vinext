import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  collectAsyncModules,
  createSideEffectsDeclarationCheck,
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
    // Imports a side-effect-free one it never uses from a chunk it loads for
    // another import.
    "/shared.tsx": { code: "export {};", importedIds: ["/lib/used.ts", "/lib/pure.ts"] },
    "/lib/used.ts": { code: "export {};", importedIds: [] },
    "/lib/pure.ts": { code: "await setup();", importedIds: [] },
  };
  const getModuleInfo = (id: string) => graph[id] ?? null;
  const declaresSideEffects = (id: string) => id === "/lib/pure.ts";
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
    { fileName: "shared.js", imports: ["lib-shared.js"], modules: rendered("/shared.tsx") },
    { fileName: "lib-shared.js", imports: [], modules: rendered("/lib/used.ts", "/lib/pure.ts") },
  ];

  it("marks roots that await at the top level or import a module that does", () => {
    const roots = ["/direct.tsx", "/importer.tsx", "/sync.tsx", "/external", "/elsewhere-user.tsx"];

    expect(collectAsyncModules({ roots, getModuleInfo, chunks, declaresSideEffects })).toEqual(
      new Set(["/direct.tsx", "/importer.tsx", "/elsewhere-user.tsx"]),
    );
  });

  it("ignores imports the emitted output dropped", () => {
    const roots = ["/shaken.tsx", "/dropped.tsx", "/shared.tsx"];

    expect(collectAsyncModules({ roots, getModuleInfo, chunks, declaresSideEffects })).toEqual(
      new Set(),
    );
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

describe("createSideEffectsDeclarationCheck", () => {
  it("reads the sideEffects field of the package a module belongs to", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-side-effects-"));
    try {
      const write = (file: string, json: object) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), JSON.stringify(json));
      };
      write("package.json", { name: "app" });
      write("node_modules/pure/package.json", { name: "pure", sideEffects: false });
      // A nested package.json that only sets the module type defers upwards.
      write("node_modules/pure/dist/package.json", { type: "module" });
      write("node_modules/listed/package.json", { name: "listed", sideEffects: ["*.css"] });
      write("node_modules/impure/package.json", { name: "impure", sideEffects: true });
      const declaresSideEffects = createSideEffectsDeclarationCheck();

      expect(declaresSideEffects(path.join(root, "node_modules/pure/dist/index.js"))).toBe(true);
      expect(declaresSideEffects(path.join(root, "node_modules/listed/index.js"))).toBe(true);
      expect(declaresSideEffects(path.join(root, "node_modules/impure/index.js"))).toBe(false);
      expect(declaresSideEffects(path.join(root, "app/page.tsx?v=1"))).toBe(false);
      expect(declaresSideEffects("\0virtual:module")).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
