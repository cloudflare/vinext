import path from "node:path";
import { createBuilder, rolldownVersion, type Rolldown } from "vite";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import {
  collectPagesAppChunkRoots,
  PAGES_INLINE_COMMON_CHUNK_MAX_SIZE,
  supportsInlineCommonChunks,
  withInlineCommonChunks,
} from "../packages/vinext/src/build/client-build-config.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/pages-client-chunks");

async function buildChunks(
  options: { disableNextLikeChunking?: boolean } = {},
  environmentNames: string[] = ["client"],
): Promise<Rolldown.OutputChunk[][]> {
  const builder = await createBuilder({
    root: FIXTURE,
    configFile: false,
    plugins: [vinext({ disableAppRouter: true, ...options })],
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

describe("Pages Router client chunks", () => {
  it("loads _app's imports as one chunk, copies small shared modules into pages, keeps shared CSS in one chunk", async () => {
    const chunks = await buildClientChunks();

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

    // A module chunk with a stylesheet is never copied.
    const panelChunks = chunksWith(chunks, "/lib/shared-panel.module.css");
    expect(panelChunks).toHaveLength(1);
    expect(facadeOf(panelChunks[0]!)).toBeUndefined();

    const labelChunks = chunksWith(chunks, "/lib/shared-label.ts").map(
      (chunk) => facadeOf(chunk) ?? "",
    );
    if (supportsInlineCommonChunks(rolldownVersion)) {
      expect([...labelChunks].sort((a, b) => a.localeCompare(b))).toEqual([
        "pages/alpha.tsx",
        "pages/beta.tsx",
        "pages/index.tsx",
      ]);
    } else {
      expect(labelChunks).toEqual([""]);
    }
  });

  it("leaves the SSR build that follows the client build alone", async () => {
    const [, ssrChunks] = await buildChunks({}, ["client", "ssr"]);
    expect(ssrChunks!.filter((chunk) => chunk.name === "pages-app")).toEqual([]);
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
  const options = { rolldownVersion: "1.2.18" };

  it("turns on inlining small common chunks, except stylesheets", () => {
    const codeSplitting: unknown = withInlineCommonChunks(output, options)?.codeSplitting;
    const inline = (
      codeSplitting as { experimentalInlineCommonChunks: { maxSize: number; exclude: RegExp } }
    ).experimentalInlineCommonChunks;
    expect(inline.maxSize).toBe(PAGES_INLINE_COMMON_CHUNK_MAX_SIZE);
    expect(inline.exclude.test("/app/lib/panel.module.css")).toBe(true);
    expect(inline.exclude.test("/app/lib/theme.scss?inline")).toBe(true);
    expect(inline.exclude.test("/app/lib/panel.tsx")).toBe(false);
  });

  it.each([
    ["an older Rolldown", output, { rolldownVersion: "1.2.17" }],
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
