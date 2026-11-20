import path from "node:path";
import { createBuilder, rolldownVersion, type Plugin, type Rolldown } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  collectUncopiedStylesheets,
  collectPagesAppChunkRoots,
  PAGES_INLINE_COMMON_CHUNK_MAX_SIZE,
  supportsInlineCommonChunks,
  withInlineCommonChunks,
} from "../packages/vinext/src/build/client-build-config.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/pages-client-chunks");

async function buildChunks(
  options: { disableNextLikeChunking?: boolean } = {},
  environmentNames: string[] = ["client"],
  plugins: Plugin[] = [],
): Promise<Rolldown.OutputChunk[][]> {
  const builder = await createBuilder({
    root: FIXTURE,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true, ...options }), ...plugins],
    environments: { client: { build: { write: false } }, ssr: { build: { write: false } } },
    logLevel: "silent",
  });

  const builds: Rolldown.OutputChunk[][] = [];
  for (const name of environmentNames) {
    const result = await builder.build(builder.environments[name]!);
    builds.push(
      (Array.isArray(result) ? result : [result as Rolldown.RolldownOutput])
        .flatMap((output) => output.output)
        .filter((item): item is Rolldown.OutputChunk => item.type === "chunk"),
    );
  }

  return builds;
}

async function buildClientChunks(
  options: { disableNextLikeChunking?: boolean } = {},
): Promise<Rolldown.OutputChunk[]> {
  const [chunks] = await buildChunks(options);
  return chunks!;
}

function chunksWith(chunks: Rolldown.OutputChunk[], file: string): Rolldown.OutputChunk[] {
  return chunks.filter((chunk) => chunk.moduleIds.some((id) => id.endsWith(file)));
}

function facadeOf(chunk: Rolldown.OutputChunk): string | undefined {
  return chunk.facadeModuleId?.slice(FIXTURE.length + 1);
}

/** A plugin that collects the build's stylesheets into `stylesheets`, by file name. */
function collectStylesheets(stylesheets: Map<string, string>): Plugin {
  return {
    name: "test:collect-stylesheets",
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === "asset" && item.fileName.endsWith(".css")) {
          stylesheets.set(item.fileName, String(item.source));
        }
      }
    },
  };
}

function importedCss(chunk: Rolldown.OutputChunk): Set<string> {
  return (
    (chunk as { viteMetadata?: { importedCss: Set<string> } }).viteMetadata?.importedCss ??
    new Set()
  );
}

/** The sorted facades of `chunks`, with "" for a chunk that has none. */
function facadesOf(chunks: Rolldown.OutputChunk[]): string[] {
  return chunks.map((chunk) => facadeOf(chunk) ?? "").sort((a, b) => a.localeCompare(b));
}

describe("Pages Router client chunks", () => {
  it("loads _app's imports as one chunk and copies small shared modules into pages", async () => {
    const stylesheets = new Map<string, string>();
    const [chunks] = (await buildChunks({}, ["client"], [collectStylesheets(stylesheets)])) as [
      Rolldown.OutputChunk[],
    ];

    // `_app` keeps its own chunk, which the client entry imports and the
    // Pages manifests look up by source path.
    const appChunks = chunksWith(chunks, "/pages/_app.tsx");
    expect(appChunks.map(facadeOf)).toEqual(["pages/_app.tsx"]);

    // A module `_app` shares with a page loads in one chunk `_app` imports.
    const brandChunks = chunksWith(chunks, "/lib/brand.ts");
    expect(brandChunks).toHaveLength(1);
    expect(facadeOf(brandChunks[0]!)).toBeUndefined();
    expect(appChunks[0]!.imports).toContain(brandChunks[0]!.fileName);

    // An import that uses next/link joins it too.
    expect(chunksWith(chunks, "/lib/home-link.tsx")).toEqual(brandChunks);

    // The client entry, which loads instrumentation-client before `_app`,
    // doesn't load that chunk with it.
    const entryChunk = chunks.find((chunk) => chunk.isEntry)!;
    expect(chunksWith([entryChunk], "/lib/telemetry.ts")).toHaveLength(1);
    expect(entryChunk.imports).not.toContain(brandChunks[0]!.fileName);

    // Only what `_app` uses from a side-effect-free barrel joins it.
    const badgeChunks = chunksWith(chunks, "/lib/kit/kit-badge.ts");
    expect(badgeChunks.length).toBeGreaterThan(0);
    for (const chunk of badgeChunks) {
      expect(chunk.moduleIds.filter((id) => /\/(_app\.tsx|brand\.ts)$/.test(id))).toEqual([]);
    }

    // A small module that pages share is copied into each of them, and so is
    // a small stylesheet.
    const inlines = supportsInlineCommonChunks(rolldownVersion);
    expect(facadesOf(chunksWith(chunks, "/lib/shared-label.ts"))).toEqual(
      inlines ? ["pages/alpha.tsx", "pages/beta.tsx", "pages/index.tsx"] : [""],
    );
    expect(facadesOf(chunksWith(chunks, "/lib/shared-panel.module.css"))).toEqual(
      inlines ? ["pages/alpha.tsx", "pages/beta.tsx"] : [""],
    );

    // Each copy's CSS joins its page's stylesheet.
    const stylesheetsWith = (className: string) =>
      [...stylesheets]
        .filter(([, css]) => css.includes(`._${className}_`))
        .map(([fileName]) => fileName);
    const importersOf = (fileNames: string[]) =>
      facadesOf(chunks.filter((chunk) => fileNames.some((file) => importedCss(chunk).has(file))));
    expect(stylesheetsWith("panel")).toHaveLength(1);
    expect(importersOf(stylesheetsWith("panel"))).toEqual(
      inlines ? ["pages/alpha.tsx", "pages/beta.tsx"] : [""],
    );

    // Stylesheets that the same pages share keep one chunk once together they
    // hold 20 kB of CSS, as in webpack, though each holds less.
    const galleryChunks = chunksWith(chunks, "/lib/shared-gallery.module.css");
    expect(facadesOf(galleryChunks)).toEqual([""]);
    expect(chunksWith(chunks, "/lib/shared-gallery-grid.module.css")).toEqual(galleryChunks);
    expect(stylesheetsWith("gallery-item-0")).toEqual([...importedCss(galleryChunks[0]!)]);
    expect(stylesheetsWith("grid-item-0")).toEqual(stylesheetsWith("gallery-item-0"));
  });

  it("leaves the SSR build that follows the client build alone", async () => {
    const [, ssrChunks] = await buildChunks({}, ["client", "ssr"]);
    expect(ssrChunks!.filter((chunk) => chunk.name === "pages-app")).toEqual([]);
  });

  it("leaves library builds alone", async () => {
    const builder = await createBuilder({
      root: FIXTURE,
      configFile: false,
      plugins: [vinext({ disableAppRouter: true })],
      build: {
        lib: { entry: path.join(FIXTURE, "lib/library-entry.ts"), formats: ["es"] },
        write: false,
      },
      logLevel: "silent",
    });

    const result = await builder.build(builder.environments.client!);
    const chunks = (Array.isArray(result) ? result : [result as Rolldown.RolldownOutput])
      .flatMap((output) => output.output)
      .filter((item): item is Rolldown.OutputChunk => item.type === "chunk");

    expect(chunks.map((chunk) => chunk.name)).not.toContain("pages-app");
  });

  it("doesn't copy shared modules when a plugin turns on onDemandWrapping", async () => {
    const onDemandWrapping: Plugin = {
      name: "test:on-demand-wrapping",
      options(inputOptions) {
        inputOptions.experimental = { ...inputOptions.experimental, onDemandWrapping: true };
      },
    };

    const [chunks] = await buildChunks({}, ["client"], [onDemandWrapping]);

    expect(chunksWith(chunks!, "/lib/shared-label.ts").map(facadeOf)).toEqual([undefined]);
  });

  it("leaves Pages Router chunking to the bundler with disableNextLikeChunking", async () => {
    const chunks = await buildClientChunks({ disableNextLikeChunking: true });

    const brandChunks = chunksWith(chunks, "/lib/brand.ts");
    expect(brandChunks).toHaveLength(1);
    expect(chunksWith(brandChunks, "/pages/_app.tsx")).toEqual([]);
    expect(chunksWith(chunks, "/lib/shared-label.ts").map(facadeOf)).toEqual([undefined]);
  });
});

describe("collectPagesAppChunkRoots", () => {
  const chunkNames: Record<string, string> = {
    "/nm/react/index.js": "framework",
    "/vinext/shims/link.js": "vinext",
    "/vinext/shims/error.js": "vinext",
    "/vinext/shims/navigation.js": "vinext-navigation",
  };

  function collect(
    graph: Record<string, { entry?: boolean; imports?: string[]; dynamicImports?: string[] }>,
  ) {
    const ids = Object.keys(graph);

    const info = (id: string) =>
      graph[id]
        ? {
            isEntry: graph[id].entry === true,
            importedIds: graph[id].imports ?? [],
            importers: ids.filter((other) => graph[other]!.imports?.includes(id)),
            dynamicImporters: ids.filter((other) => graph[other]!.dynamicImports?.includes(id)),
          }
        : null;

    return [...collectPagesAppChunkRoots("/app/pages/_app.tsx", ids, info, (id) => chunkNames[id])];
  }

  it("takes _app's static imports short of the chunks the first group takes", () => {
    expect(
      collect({
        "/entry.js": { entry: true, dynamicImports: ["/app/pages/_app.tsx"] },
        "/app/pages/_app.tsx": {
          imports: [
            "/app/lib/frame.tsx",
            "/app/styles/globals.css",
            "/nm/react/index.js",
            "/vinext/shims/link.js",
            "/vinext/shims/navigation.js",
          ],
        },
        "/app/lib/frame.tsx": { imports: ["/app/lib/util.ts"] },
        "/app/lib/util.ts": {},
        "/app/styles/globals.css": {},
        "/nm/react/index.js": {},
        "/vinext/shims/link.js": { imports: ["/vinext/shims/error.js"] },
        "/vinext/shims/error.js": {},
        "/vinext/shims/navigation.js": {},
        "/vinext/lazy.js": { dynamicImports: ["/vinext/shims/error.js"] },
      }),
    ).toEqual(["/app/lib/frame.tsx", "/app/styles/globals.css", "/vinext/shims/navigation.js"]);
  });

  it("groups _app's stylesheets when a page imports one of them too", () => {
    expect(
      collect({
        "/entry.js": {
          entry: true,
          dynamicImports: ["/app/pages/_app.tsx", "/app/pages/index.tsx"],
        },
        "/app/pages/_app.tsx": { imports: ["/nm/lib/lib.css", "/app/styles/overrides.css"] },
        "/app/pages/index.tsx": { imports: ["/nm/lib/lib.css"] },
        "/nm/lib/lib.css": {},
        "/app/styles/overrides.css": {},
      }),
    ).toEqual(["/nm/lib/lib.css", "/app/styles/overrides.css"]);
  });

  it("leaves stylesheets alone in _app's chunk when _app imports nothing else", () => {
    expect(
      collect({
        "/entry.js": { entry: true, dynamicImports: ["/app/pages/_app.tsx"] },
        "/app/pages/_app.tsx": {
          imports: ["/app/styles/globals.css", "/app/styles/theme.scss", "/nm/react/index.js"],
        },
        "/app/styles/globals.css": {},
        "/app/styles/theme.scss": {},
        "/nm/react/index.js": {},
      }),
    ).toEqual([]);
  });

  it("leaves out imports that lead back to _app, to a module loaded with import() or to a module the client entry loads", () => {
    expect(
      collect({
        "/entry.js": {
          entry: true,
          imports: [
            "/app/instrumentation-client.ts",
            "/vinext/client/bootstrap.js",
            "/vinext/utils/base-path.js",
          ],
          dynamicImports: ["/app/pages/_app.tsx", "/app/pages/index.tsx"],
        },
        "/app/instrumentation-client.ts": { imports: ["/app/lib/telemetry.ts", "\0virtual:flags"] },
        "/app/lib/telemetry.ts": {},
        "\0virtual:flags": {},
        "/vinext/client/bootstrap.js": { imports: ["/vinext/client/instance.js"] },
        "/vinext/client/instance.js": {},
        "/vinext/client/index.js": { imports: ["/vinext/client/instance.js"] },
        // The first group takes base-path with next/link, so it never joins `_app`.
        "/vinext/shims/link.js": { imports: ["/vinext/utils/base-path.js"] },
        "/vinext/utils/base-path.js": {},
        "/app/pages/_app.tsx": {
          imports: [
            "/app/lib/layout.tsx",
            "/app/lib/nav.tsx",
            "/app/lib/widget.tsx",
            "/app/lib/tracked.tsx",
            "/app/lib/flagged.tsx",
            "/vinext/client/index.js",
            "/app/lib/linked.tsx",
          ],
        },
        "/app/lib/layout.tsx": { imports: ["/app/lib/context.ts"] },
        "/app/lib/context.ts": { imports: ["/app/pages/_app.tsx"] },
        "/app/lib/nav.tsx": { imports: ["/app/pages/index.tsx"] },
        "/app/pages/index.tsx": { dynamicImports: ["/app/lib/widget.tsx"] },
        "/app/lib/widget.tsx": {},
        "/app/lib/tracked.tsx": { imports: ["/app/lib/telemetry.ts"] },
        "/app/lib/flagged.tsx": { imports: ["\0virtual:flags"] },
        "/app/lib/linked.tsx": { imports: ["/vinext/shims/link.js", "/vinext/utils/base-path.js"] },
      }),
    ).toEqual(["/app/lib/linked.tsx"]);
  });
});

describe("collectUncopiedStylesheets", () => {
  // `entry` is the client entry, which loads the pages with `import()`.
  const graph: Record<string, { importers: string[]; entry?: boolean; loadedBy?: string }> = {
    entry: { importers: [], entry: true },
    alpha: { importers: [], loadedBy: "entry" },
    beta: { importers: [], loadedBy: "entry" },
    gallery: { importers: ["alpha", "beta"] },
    "gallery.css": { importers: ["gallery"] },
    "gallery-grid.css": { importers: ["gallery"] },
    "beta.css": { importers: ["beta"] },
    "frame.css": { importers: ["entry", "alpha"] },
    dialog: { importers: [], loadedBy: "beta" },
    card: { importers: ["beta", "dialog"] },
    "card.css": { importers: ["card"] },
    "dialog.css": { importers: ["dialog"] },
  };
  const getModuleInfo = (id: string) => {
    const node = graph[id];
    return node
      ? {
          isEntry: node.entry === true,
          importers: node.importers,
          dynamicImporters: node.loadedBy ? [node.loadedBy] : [],
        }
      : null;
  };
  const collect = (sizes: Map<string, number>) =>
    collectUncopiedStylesheets(sizes, getModuleInfo, "entry");

  it("keeps the stylesheets of each set of pages that together reach the size", () => {
    const sizes = new Map([
      ["gallery.css", 12_000],
      ["gallery-grid.css", 9_000],
      ["beta.css", 15_000],
      ["frame.css", 19_999],
    ]);

    expect([...collect(sizes)].sort()).toEqual(["gallery-grid.css", "gallery.css"]);
  });

  it("copies the stylesheets of a set of pages that together stay below the size", () => {
    const sizes = new Map([
      ["gallery.css", 10_000],
      ["gallery-grid.css", 9_999],
    ]);

    expect(collect(sizes)).toEqual(new Set());
  });

  // A copy in the `next/dynamic` chunk would link the CSS after the page's own.
  it("keeps the stylesheets that a page shares with an import() target", () => {
    const sizes = new Map([
      ["card.css", 100],
      ["dialog.css", 100],
    ]);

    expect(collect(sizes)).toEqual(new Set(["card.css"]));
  });
});

describe("supportsInlineCommonChunks", () => {
  it.each([
    ["1.2.18", true],
    ["1.2.19", true],
    ["1.3.0", true],
    ["2.0.0", true],
    ["1.2.17", false],
    ["1.2.18-beta.1", false],
    ["1.0.0-rc.9", false],
  ])("Rolldown %s → %s", (version, expected) => {
    expect(supportsInlineCommonChunks(version)).toBe(expected);
  });
});

describe("withInlineCommonChunks", () => {
  const output = { codeSplitting: { groups: [] } };
  const options = {
    rolldownVersion: "1.2.18",
    uncopiedStylesheets: new Set(["/app/lib/gallery.module.css"]),
  };

  it("turns on inlining small common chunks, except those with large shared stylesheets", () => {
    const codeSplitting: unknown = withInlineCommonChunks(output, options)?.codeSplitting;
    const inline = (
      codeSplitting as {
        experimentalInlineCommonChunks: { maxSize: number; exclude: (id: string) => boolean };
      }
    ).experimentalInlineCommonChunks;

    expect(inline.maxSize).toBe(PAGES_INLINE_COMMON_CHUNK_MAX_SIZE);
    expect(inline.exclude("/app/lib/gallery.module.css")).toBe(true);
    expect(inline.exclude("/app/lib/panel.module.css")).toBe(false);
    expect(inline.exclude("/app/lib/panel.tsx")).toBe(false);
  });

  it.each([
    ["an older Rolldown", output, { ...options, rolldownVersion: "1.2.17" }],
    [
      "inlining the output already configures",
      { codeSplitting: { experimentalInlineCommonChunks: { maxSize: 0 } } },
      options,
    ],
    ["no code splitting", { codeSplitting: false }, options],
    ["a non-ESM output", { ...output, format: "cjs" }, options],
    ["preserveModules", { ...output, preserveModules: true }, options],
    ["strictExecutionOrder: false", { ...output, strictExecutionOrder: false }, options],
    ["strict entry signatures", output, { ...options, preserveEntrySignatures: "strict" }],
    ["on-demand wrapping", output, { ...options, onDemandWrapping: true }],
  ])("leaves the output alone with %s", (_case, caseOutput, caseOptions) => {
    expect(withInlineCommonChunks(caseOutput, caseOptions)).toBeUndefined();
  });
});
