import { describe, expect, it } from "vite-plus/test";
import { createServerActionClientSourcemapPlugin } from "../packages/vinext/src/plugins/server-action-client-sourcemap.js";

type Hook = { handler: (this: unknown, ...args: never[]) => unknown };
type Bundle = Record<string, Record<string, unknown>>;

const ACTION_ID = "/app/app/actions.ts";
const CLIENT_ID = "/app/app/button.tsx";
const ACTION_SOURCE = '"use server";\nexport async function save() { return "PRIVATE"; }\n';
const CLIENT_SOURCE = '"use client";\nexport function Button() {}\n';
const MODULES = { [ACTION_ID]: ACTION_SOURCE, [CLIENT_ID]: CLIENT_SOURCE };

function sourcemap(sources: string[], sourcesContent: string[]) {
  return { version: 3, sources, sourcesContent, mappings: "" };
}

const DEFAULT_MAP = sourcemap(
  ["../app/actions.ts", "../app/button.tsx"],
  [ACTION_SOURCE, CLIENT_SOURCE],
);

const toDataUrl = (content: string) =>
  `../app/data:text/javascript;base64,${Buffer.from(content).toString("base64")}`;

function chunk({
  code = "export{};",
  map = null as object | null,
  sourcemapFileName = "chunks/button.js.map" as string | null,
} = {}) {
  return {
    type: "chunk",
    fileName: "chunks/button.js",
    sourcemapFileName,
    moduleIds: Object.keys(MODULES),
    code,
    map,
  };
}

async function generate(
  bundle: Bundle,
  {
    serverReferences = [ACTION_ID],
    consumer = "client",
    modules = MODULES,
    originals = {},
    combinedMaps = {},
    between,
  }: {
    serverReferences?: string[];
    consumer?: "client" | "server";
    modules?: Record<string, string>;
    originals?: Record<string, string>;
    combinedMaps?: Record<string, object>;
    between?: (bundle: Bundle) => void;
  } = {},
) {
  const metaMap = new Map(serverReferences.map((id) => [id, {}]));
  const [scrub, track] = createServerActionClientSourcemapPlugin({
    getManager: async () => ({ serverReferences: { metaMap } }) as never,
  });
  // No configured sourcemap: `outputOptions` can still enable one after transforms.
  const environment = { name: consumer, config: { consumer, build: {} } };
  (scrub!.configResolved as (config: unknown) => void)({});
  (scrub!.buildStart as (this: unknown) => void).call({ environment });
  for (const [id, code] of Object.entries(modules)) {
    const original = originals[id];
    const getCombinedSourcemap = () => combinedMaps[id] ?? { sourcesContent: [original ?? code] };
    for (const plugin of [scrub!, track!]) {
      (plugin.transform as Hook).handler.call(
        { environment, getCombinedSourcemap },
        code as never,
        id as never,
      );
    }
  }
  await (scrub!.generateBundle as Hook).handler.call({ environment }, {} as never, bundle as never);
  between?.(bundle);
  await (track!.generateBundle as Hook).handler.call({ environment }, {} as never, bundle as never);
  return bundle;
}

function withAsset(map: object) {
  return {
    "chunks/button.js": chunk(),
    "chunks/button.js.map": { type: "asset", source: JSON.stringify(map) },
  };
}

function assetContent(bundle: Bundle) {
  return JSON.parse(String(bundle["chunks/button.js.map"]!.source)).sourcesContent;
}

describe("vinext:server-action-client-sourcemap", () => {
  it("only runs in builds", () => {
    const plugins = createServerActionClientSourcemapPlugin({ getManager: async () => undefined });
    expect(plugins.map((plugin) => plugin.apply)).toEqual(["build", "build"]);
  });

  it("scrubs before and after other generateBundle hooks", async () => {
    const plugins = createServerActionClientSourcemapPlugin({ getManager: async () => undefined });
    expect(plugins.map((plugin) => (plugin.generateBundle as { order: string }).order)).toEqual([
      "pre",
      "post",
    ]);
    let copied: unknown;
    const bundle = await generate(withAsset(DEFAULT_MAP), {
      between(bundle) {
        copied = bundle["chunks/button.js.map"]!.source;
        bundle["chunks/button.js.map"]!.source = JSON.stringify(DEFAULT_MAP);
      },
    });
    expect(JSON.parse(String(copied)).sourcesContent).toEqual([null, CLIENT_SOURCE]);
    expect(assetContent(bundle)).toEqual([null, CLIENT_SOURCE]);
  });

  it("nulls server action content in emitted .map assets", async () => {
    const bundle = await generate(withAsset(DEFAULT_MAP));
    expect(JSON.parse(String(bundle["chunks/button.js.map"]!.source)).sources).toEqual(
      DEFAULT_MAP.sources,
    );
    expect(assetContent(bundle)).toEqual([null, CLIENT_SOURCE]);
  });

  it("nulls it in inline maps", async () => {
    const encoded = Buffer.from(JSON.stringify(DEFAULT_MAP)).toString("base64");
    const bundle = await generate({
      "chunks/button.js": chunk({
        code: `export{};\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`,
      }),
    });
    const code = String(bundle["chunks/button.js"]!.code);
    const inline = /base64,([A-Za-z0-9+/=]+)\n$/.exec(code)![1]!;
    expect(JSON.parse(Buffer.from(inline, "base64").toString("utf8")).sourcesContent).toEqual([
      null,
      CLIENT_SOURCE,
    ]);
  });

  it("reassigns the scrubbed chunk map so later plugins and the output see it", async () => {
    const assigned: unknown[] = [];
    const target = chunk({ map: structuredClone(DEFAULT_MAP) });
    // Rolldown only syncs top-level assignments back from its bundle proxy.
    const proxy = new Proxy(target, {
      set(object, property, value) {
        if (property === "map") assigned.push(value);
        return Reflect.set(object, property, value);
      },
    });
    await generate({ "chunks/button.js": proxy });
    expect(assigned).toEqual([sourcemap(DEFAULT_MAP.sources, [null!, CLIENT_SOURCE])]);
  });

  it.each([
    [
      "colliding source names",
      sourcemap(["shared.ts", "shared.ts"], [ACTION_SOURCE, CLIENT_SOURCE]),
    ],
    [
      "a loader-supplied map that names a public module",
      sourcemap(["../app/button.tsx", "../app/button.tsx"], [ACTION_SOURCE, CLIENT_SOURCE]),
    ],
    [
      "a loader-supplied map with another original",
      sourcemap(
        ["../src/original.ts", "../app/button.tsx"],
        ['"use server";\n// original', CLIENT_SOURCE],
      ),
    ],
  ])("keeps only the chunk's public module content for %s", async (_name, map) => {
    expect(assetContent(await generate(withAsset(map)))).toEqual([null, CLIENT_SOURCE]);
  });

  it("redacts data: URL sources that carry dropped content", async () => {
    const dataUrl = toDataUrl(ACTION_SOURCE);
    const bundle = await generate(
      withAsset(sourcemap([dataUrl, "../app/button.tsx"], [ACTION_SOURCE, CLIENT_SOURCE])),
    );
    const map = JSON.parse(String(bundle["chunks/button.js.map"]!.source));
    expect(map.sources).toEqual(["data:,", "../app/button.tsx"]);
    expect(map.sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it("redacts only private data: URL sources without sourcesContent", async () => {
    const generated = `${CLIENT_SOURCE}export const injected = 1;\n`;
    const publicOriginal = '"use client";\n// public loader original\n';
    const bundle = await generate(
      withAsset({
        version: 3,
        sources: [toDataUrl(ACTION_SOURCE), toDataUrl(publicOriginal)],
        mappings: "",
      }),
      {
        modules: { [ACTION_ID]: ACTION_SOURCE, [CLIENT_ID]: generated },
        combinedMaps: { [CLIENT_ID]: { sources: [toDataUrl(publicOriginal)] } },
      },
    );
    const map = JSON.parse(String(bundle["chunks/button.js.map"]!.source));
    expect(map.sources).toEqual(["data:,", toDataUrl(publicOriginal)]);
  });

  it("redacts a private data: URL source even when its sourcesContent is public", async () => {
    const bundle = await generate(
      withAsset(
        sourcemap([toDataUrl(ACTION_SOURCE), "../app/button.tsx"], [CLIENT_SOURCE, CLIENT_SOURCE]),
      ),
    );
    const map = JSON.parse(String(bundle["chunks/button.js.map"]!.source));
    expect(map.sources).toEqual(["data:,", "../app/button.tsx"]);
    expect(map.sourcesContent).toEqual([CLIENT_SOURCE, CLIENT_SOURCE]);
  });

  it("checks sourcesContent entries past the end of sources", async () => {
    const bundle = await generate(
      withAsset({
        version: 3,
        sources: ["../app/actions.ts"],
        sourcesContent: [null, ACTION_SOURCE],
        mappings: "",
      }),
    );
    expect(assetContent(bundle)).toEqual([null, null]);
  });

  it("redacts a data: URL that spans sourceRoot and the source", async () => {
    const bundle = await generate(
      withAsset({
        version: 3,
        sourceRoot: "data:text/javascript,",
        sources: [encodeURIComponent(ACTION_SOURCE), encodeURIComponent(CLIENT_SOURCE)],
        mappings: "",
      }),
    );
    const map = JSON.parse(String(bundle["chunks/button.js.map"]!.source));
    expect(map.sourceRoot).toBeUndefined();
    expect(map.sources).toEqual([
      "data:,",
      `data:text/javascript,${encodeURIComponent(CLIENT_SOURCE)}`,
    ]);
  });

  it("scrubs the section maps of an index map", async () => {
    const indexMap = {
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: structuredClone(DEFAULT_MAP) },
        {
          offset: { line: 1, column: 0 },
          map: { version: 3, sources: [toDataUrl(ACTION_SOURCE)], mappings: "" },
        },
      ],
    };
    const bundle = await generate(withAsset(indexMap));
    const map = JSON.parse(String(bundle["chunks/button.js.map"]!.source));
    expect(map.sections[0].map.sourcesContent).toEqual([null, CLIENT_SOURCE]);
    expect(map.sections[1].map.sources).toEqual(["data:,"]);
  });

  it("redacts index map sections that embed their map as a data: URL", async () => {
    const embedded = `data:application/json;base64,${Buffer.from(JSON.stringify(DEFAULT_MAP)).toString("base64")}`;
    const bundle = await generate(
      withAsset({ version: 3, sections: [{ offset: { line: 0, column: 0 }, url: embedded }] }),
    );
    expect(JSON.parse(String(bundle["chunks/button.js.map"]!.source)).sections[0].url).toBe(
      "data:,",
    );
  });

  it("keeps public originals from an index combined map", async () => {
    const generated = `${CLIENT_SOURCE}export const injected = 1;\n`;
    const publicOriginal = '"use client";\n// sectioned original\n';
    const bundle = await generate(
      withAsset(
        sourcemap(["../app/actions.ts", "../src/original.ts"], [ACTION_SOURCE, publicOriginal]),
      ),
      {
        modules: { [ACTION_ID]: ACTION_SOURCE, [CLIENT_ID]: generated },
        combinedMaps: {
          [CLIENT_ID]: {
            sections: [{ map: { sources: ["original.ts"], sourcesContent: [publicOriginal] } }],
          },
        },
      },
    );
    expect(assetContent(bundle)).toEqual([null, publicOriginal]);
  });

  it("leaves source names that only contain data: alone", async () => {
    const map = {
      version: 3,
      sources: ["../metadata:types.ts", "../app/button.tsx"],
      mappings: "",
    };
    const bundle = await generate(withAsset(map));
    expect(bundle["chunks/button.js.map"]!.source).toBe(JSON.stringify(map));
  });

  it("ignores a same-named asset when the chunk has no external map", async () => {
    const bundle = await generate({
      "chunks/button.js": chunk({ sourcemapFileName: null }),
      "chunks/button.js.map": { type: "asset", source: "not a sourcemap" },
    });
    expect(bundle["chunks/button.js.map"]!.source).toBe("not a sourcemap");
  });

  it("reads byte-backed .map assets", async () => {
    const bundle = await generate({
      "chunks/button.js": chunk(),
      "chunks/button.js.map": {
        type: "asset",
        source: new TextEncoder().encode(JSON.stringify(DEFAULT_MAP)),
      },
    });
    expect(assetContent(bundle)).toEqual([null, CLIENT_SOURCE]);
  });

  it("keeps the original a public module's final combined map points to, even before sourcemaps are configured", async () => {
    const generated = `${CLIENT_SOURCE}export const injected = 1;\n`;
    const bundle = await generate(withAsset(DEFAULT_MAP), {
      modules: { [ACTION_ID]: ACTION_SOURCE, [CLIENT_ID]: generated },
      originals: { [CLIENT_ID]: CLIENT_SOURCE },
    });
    expect(assetContent(bundle)).toEqual([null, CLIENT_SOURCE]);
  });

  it.each([
    ["chunks without server references", { serverReferences: [] as string[] }],
    ["server builds", { consumer: "server" as const }],
  ])("leaves maps unchanged for %s", async (_name, options) => {
    const bundle = await generate(withAsset(DEFAULT_MAP), options);
    expect(bundle["chunks/button.js.map"]!.source).toBe(JSON.stringify(DEFAULT_MAP));
  });
});
