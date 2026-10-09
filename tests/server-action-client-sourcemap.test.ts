import { describe, expect, it } from "vite-plus/test";
import { createServerActionClientSourcemapPlugin } from "../packages/vinext/src/plugins/server-action-client-sourcemap.js";

type Hook = { handler: (this: unknown, ...args: never[]) => unknown };
type Bundle = Record<string, Record<string, unknown>>;

const OUT_DIR = "/app/dist/client";
const ACTION_ID = "/app/app/actions.ts";
const ACTION_SOURCE = '"use server";\nexport async function save() { return "PRIVATE"; }\n';
const CLIENT_SOURCE = '"use client";\nexport function Button() {}\n';

function sourcemap(sources: string[], sourcesContent: string[]) {
  return JSON.stringify({ version: 3, sources, sourcesContent, mappings: "" });
}

function inlineSourcemap(json: string) {
  return `//# sourceMappingURL=data:application/json;base64,${Buffer.from(json).toString("base64")}\n`;
}

async function build(
  modules: Record<string, string>,
  bundle: Bundle,
  options: Record<string, unknown> = {},
  consumer: "client" | "server" = "client",
) {
  const plugin = createServerActionClientSourcemapPlugin();
  const context = { environment: { name: consumer, config: { consumer } } };
  (plugin.buildStart as (this: unknown) => void).call(context);
  for (const [id, code] of Object.entries(modules)) {
    await (plugin.transform as Hook).handler.call(context, code as never, id as never);
  }
  (plugin.generateBundle as Hook).handler.call(
    context,
    { dir: OUT_DIR, ...options } as never,
    bundle as never,
  );
  return bundle;
}

function chunkWithMap(modules: Record<string, string>, code = "export{};") {
  const ids = Object.keys(modules);
  const sources = ids.map((id) => `../../../../..${id.slice("/app".length)}`);
  return {
    chunk: {
      type: "chunk",
      fileName: "_next/static/chunks/button.js",
      sourcemapFileName: "_next/static/chunks/button.js.map",
      moduleIds: ids,
      code,
    },
    map: sourcemap(sources, Object.values(modules)),
  };
}

describe("vinext:server-action-client-sourcemap", () => {
  const modules = { [ACTION_ID]: ACTION_SOURCE, "/app/app/button.tsx": CLIENT_SOURCE };

  it("only runs in builds", () => {
    expect(createServerActionClientSourcemapPlugin().apply).toBe("build");
  });

  it('nulls "use server" module content in emitted .map assets', async () => {
    const { chunk, map } = chunkWithMap(modules);
    const bundle = await build(modules, {
      [chunk.fileName]: chunk,
      [chunk.sourcemapFileName]: { type: "asset", source: map },
    });
    const scrubbed = JSON.parse(String(bundle[chunk.sourcemapFileName]!.source));
    expect(scrubbed.sources).toEqual([
      "../../../../../app/actions.ts",
      "../../../../../app/button.tsx",
    ]);
    expect(scrubbed.sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it("nulls it in inline maps", async () => {
    const { chunk, map } = chunkWithMap(modules);
    chunk.code += inlineSourcemap(map);
    const bundle = await build(modules, { [chunk.fileName]: chunk });
    const encoded = /base64,([A-Za-z0-9+/=]+)\n$/.exec(String(bundle[chunk.fileName]!.code))![1]!;
    const scrubbed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(scrubbed.sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it("matches sources rewritten by sourcemapPathTransform", async () => {
    const { chunk } = chunkWithMap(modules);
    const map = sourcemap(
      ["src://../../../../../app/actions.ts", "src://../../../../../app/button.tsx"],
      Object.values(modules),
    );
    const bundle = await build(
      modules,
      { [chunk.fileName]: chunk, [chunk.sourcemapFileName]: { type: "asset", source: map } },
      { sourcemapPathTransform: (source: string) => `src://${source}` },
    );
    const scrubbed = JSON.parse(String(bundle[chunk.sourcemapFileName]!.source));
    expect(scrubbed.sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it.each([
    ["a directive after other directives and comments", '"use strict" /* c */; "use server";\r\n'],
    ["a module that does not parse yet", '"use server";\nexport async function save( {\n'],
  ])("treats %s as a server action module", async (_name, source) => {
    const actionModules = { [ACTION_ID]: source, "/app/app/button.tsx": CLIENT_SOURCE };
    const { chunk, map } = chunkWithMap(actionModules);
    const bundle = await build(actionModules, {
      [chunk.fileName]: chunk,
      [chunk.sourcemapFileName]: { type: "asset", source: map },
    });
    const scrubbed = JSON.parse(String(bundle[chunk.sourcemapFileName]!.source));
    expect(scrubbed.sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it.each([
    ["a non-prologue string", 'export const x = 1;\n"use server";\n', "client"],
    ["a string mention", 'export const label = "use server";\n', "client"],
    ["a server build", ACTION_SOURCE, "server"],
  ] as const)("leaves maps unchanged for %s", async (_name, source, consumer) => {
    const sourceModules = { [ACTION_ID]: source, "/app/app/button.tsx": CLIENT_SOURCE };
    const { chunk, map } = chunkWithMap(sourceModules);
    const bundle = await build(
      sourceModules,
      { [chunk.fileName]: chunk, [chunk.sourcemapFileName]: { type: "asset", source: map } },
      {},
      consumer,
    );
    expect(bundle[chunk.sourcemapFileName]!.source).toBe(map);
  });
});
