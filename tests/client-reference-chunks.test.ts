import { describe, expect, it } from "vite-plus/test";
import type { Rollup } from "vite";
import {
  collectClientReferenceChunks,
  collectClientReferenceSources,
} from "../packages/vinext/src/build/client-reference-chunks.js";
import {
  createClientReferenceChunksManifest,
  ssrServerConsumerManifest,
} from "../packages/vinext/src/server/app-client-reference-manifest.js";
import {
  toFlightChunks,
  type ClientReferenceChunks,
} from "../packages/vinext/src/utils/client-reference-chunks.js";
import {
  addDynamicImportPreloadAliases,
  computeDynamicImportPreloads,
} from "../packages/vinext/src/utils/lazy-chunks.js";

function chunk(
  fileName: string,
  options: { imports?: string[]; moduleIds?: string[]; css?: string[] } = {},
): Rollup.OutputChunk {
  return {
    type: "chunk",
    fileName,
    imports: options.imports ?? [],
    moduleIds: options.moduleIds ?? [],
    viteMetadata: { importedCss: new Set(options.css ?? []), importedAssets: new Set() },
  } as unknown as Rollup.OutputChunk;
}

function bundleOf(...chunks: Rollup.OutputChunk[]): Rollup.OutputBundle {
  return Object.fromEntries(chunks.map((output) => [output.fileName, output]));
}

describe("collectClientReferenceChunks", () => {
  it("collects each client reference module's chunk, imports, and stylesheets", () => {
    const entry = chunk("entry.js", { imports: ["framework.js"] });
    const bundle = bundleOf(
      entry,
      chunk("framework.js"),
      chunk("group.js", {
        moduleIds: ["/app/a.tsx", "\0group-module", "/app/b.tsx"],
        imports: ["framework.js", "shared.js"],
        css: ["a.css"],
      }),
      chunk("single.js", { moduleIds: ["\0single-module"], imports: ["shared.js"] }),
      chunk("plain.js", { moduleIds: ["\0plain-module"], imports: ["framework.js", "deep.js"] }),
      chunk("shared.js", { imports: ["deep.js"], css: ["shared.css"] }),
      chunk("deep.js"),
      chunk("unrelated.js", { moduleIds: ["/app/c.tsx"] }),
    );
    const modules = new Map([
      ["\0group-module", ["aaa", "bbb"]],
      ["\0single-module", ["ccc"]],
      ["\0plain-module", ["ddd"]],
    ]);

    expect(collectClientReferenceChunks(bundle, modules, entry)).toEqual({
      references: { aaa: 0, bbb: 0, ccc: 1, ddd: 2 },
      modules: [
        // The entry's static imports have loaded before any Flight row decodes.
        // A chunk's own stylesheets come after those of the chunks it imports.
        // A chunk preloads while its stylesheets load, as in Vite.
        {
          file: "group.js",
          imports: ["group.js", "shared.js", "deep.js"],
          css: ["shared.css", "a.css"],
        },
        { file: "single.js", imports: ["single.js", "shared.js", "deep.js"], css: ["shared.css"] },
        // Without stylesheets, the loader imports the chunk at once.
        { file: "plain.js", imports: ["deep.js"], css: [] },
      ],
    });
  });

  it("honors build.modulePreload", () => {
    const entry = chunk("entry.js", { imports: ["framework.js"] });
    const host = {
      ...chunk("host.js"),
      facadeModuleId: "\0virtual:vinext-client-reference-chunks",
    } as Rollup.OutputChunk;
    const bundle = bundleOf(
      entry,
      host,
      chunk("single.js", {
        moduleIds: ["\0single-module"],
        imports: ["framework.js", "a.js", "b.js"],
        css: ["own.css"],
      }),
      chunk("framework.js"),
      chunk("a.js"),
      chunk("b.js"),
      chunk("leaf.js", { moduleIds: ["\0leaf-module"] }),
    );
    const modules = new Map([
      ["\0single-module", ["ccc"]],
      ["\0leaf-module", ["ddd"]],
    ]);

    expect(collectClientReferenceChunks(bundle, modules, entry, false)?.modules).toEqual([
      { file: "single.js", imports: [], css: ["own.css"] },
      { file: "leaf.js", imports: [], css: [] },
    ]);
    const calls: unknown[][] = [];
    expect(
      collectClientReferenceChunks(bundle, modules, entry, {
        polyfill: true,
        resolveDependencies: (...args) => {
          calls.push(args);
          // As in Vite, a chunk that needs nothing else gets no dependencies,
          // and the callback can add some.
          if (args[1].length === 0) return ["injected.js"];
          // A stylesheet the callback adds is linked, not modulepreloaded.
          return [...args[1].filter((file) => file !== "a.js"), "extra.css", "theme.css?v=1"];
        },
      })?.modules,
    ).toEqual([
      {
        file: "single.js",
        imports: ["single.js", "b.js"],
        css: ["extra.css", "theme.css?v=1", "own.css"],
      },
      { file: "leaf.js", imports: ["injected.js"], css: [] },
    ]);
    // As in Vite, the callback sees every chunk the module chunk imports, and
    // the host is the chunk that dynamically imports each registering module.
    expect(calls).toEqual([
      [
        "single.js",
        ["single.js", "framework.js", "a.js", "b.js"],
        { hostId: "host.js", hostType: "js" },
      ],
      ["leaf.js", [], { hostId: "host.js", hostType: "js" }],
    ]);
  });

  it("returns undefined without client reference modules", () => {
    const entry = chunk("entry.js");
    expect(collectClientReferenceChunks(bundleOf(entry), new Map(), entry)).toBeUndefined();
  });
});

describe("collectClientReferenceSources", () => {
  it("maps a reference's own module to the chunk of the module that registers it", () => {
    const wrapper = "\0virtual:vinext-client-reference-module/aaa/widget";
    const query = "\0virtual:vinext-client-reference-module/bbb/styled";
    const imports: Record<string, string[]> = {
      [wrapper]: ["/repo/shims/internal/client-reference-loader.ts", "/repo/app/widget.tsx"],
      // Keyed without Vite's query, as next/dynamic's metadata keys it.
      [query]: ["/repo/shims/internal/client-reference-loader.ts", "/repo/app/styled.tsx?inline"],
      "\0virtual:vinext-client-reference-group-123": ["/repo/app/a.tsx", "/repo/app/b.tsx"],
    };
    const bundle = bundleOf(
      chunk("wrapper.js", { moduleIds: ["/repo/app/widget.tsx", wrapper] }),
      chunk("styled.js", { moduleIds: [query] }),
      chunk("group.js", { moduleIds: ["\0virtual:vinext-client-reference-group-123"] }),
    );
    expect(collectClientReferenceSources(bundle, (id) => imports[id], "/repo")).toEqual({
      "app/widget.tsx": "wrapper.js",
      "app/styled.tsx": "styled.js",
    });
    expect(collectClientReferenceSources(bundleOf(chunk("a.js")), () => [], "/repo")).toBe(
      undefined,
    );
  });
});

describe("addDynamicImportPreloadAliases", () => {
  it("gives a client reference's module the preloads of the chunk that loads it", () => {
    const buildManifest = {
      "virtual:vinext-client-reference-chunks": {
        file: "chunks.js",
        dynamicImports: ["virtual:vinext-client-reference-module/aaa/widget", "app/other.tsx"],
      },
      "virtual:vinext-client-reference-module/aaa/widget": {
        file: "wrapper.js",
        imports: ["_shared.js"],
        css: ["widget.css"],
      },
      "_shared.js": { file: "shared.js" },
      "app/other.tsx": { file: "other.js" },
    };
    const preloads = computeDynamicImportPreloads(buildManifest);
    addDynamicImportPreloadAliases(preloads, buildManifest, {
      "app/widget.tsx": "wrapper.js",
      // A module the build manifest keys itself keeps its own preloads.
      "app/other.tsx": "wrapper.js",
      "app/missing.tsx": "missing.js",
    });
    expect(preloads["app/widget.tsx"]).toEqual(["shared.js", "wrapper.js", "widget.css"]);
    expect(preloads["app/other.tsx"]).toEqual(["other.js"]);
    expect(preloads).not.toHaveProperty("app/missing.tsx");
  });
});

describe("toFlightChunks", () => {
  it("names the module chunk with its stylesheets, then its JS imports", () => {
    expect(
      toFlightChunks({ file: "/m.js", imports: ["/a.js", "/b.js"], css: ["/a.css", "/b.css"] }),
    ).toEqual(["m/m.js\n/a.css\n/b.css", "", "p/a.js", "", "p/b.js", ""]);
  });
});

describe("createClientReferenceChunksManifest", () => {
  const referenceChunks: ClientReferenceChunks = {
    references: { aaa: 0, bbb: 0 },
    modules: [{ file: "/m.js", imports: [], css: ["/a.css"] }],
  };
  const manifest = {
    "/app/a.tsx#Widget": { id: "aaa", name: "Widget", chunks: [], async: true },
    "/app/c.tsx#Other": { id: "ccc", name: "Other", chunks: [], async: true },
  };

  it("adds the chunks each client reference loads to its manifest entry", () => {
    const withChunks = createClientReferenceChunksManifest(referenceChunks)(manifest);
    expect(withChunks["/app/a.tsx#Widget"]).toEqual({
      id: "aaa",
      name: "Widget",
      chunks: ["m/m.js\n/a.css", ""],
      async: true,
    });
    // A reference without chunk data keeps plugin-rsc's entry.
    expect(withChunks["/app/c.tsx#Other"]).toBe(manifest["/app/c.tsx#Other"]);
    expect(withChunks["/app/missing.tsx#X"]).toBeUndefined();
  });

  it("does not resolve keys inherited from Object.prototype", () => {
    const withChunks = createClientReferenceChunksManifest({
      references: {},
      modules: [],
    })({ "/app/a.tsx#Widget": { id: "constructor", name: "Widget", chunks: [] } });
    expect(withChunks["/app/a.tsx#Widget"]!.chunks).toEqual([]);
  });

  it("returns the manifest unchanged without chunk data", () => {
    expect(createClientReferenceChunksManifest(undefined)(manifest)).toBe(manifest);
  });
});

describe("ssrServerConsumerManifest", () => {
  it("resolves every client reference export without chunks", () => {
    expect(ssrServerConsumerManifest.moduleMap["aaa"]!["Widget"]).toEqual({
      id: "aaa",
      chunks: [],
      name: "Widget",
    });
    // React skips preinitializing a row's chunks only for a null moduleLoading.
    expect(ssrServerConsumerManifest.moduleLoading).toBeNull();
  });
});
