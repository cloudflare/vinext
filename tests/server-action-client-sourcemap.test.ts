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

function chunk({ code = "export{};", map = null as object | null } = {}) {
  return {
    type: "chunk",
    fileName: "chunks/button.js",
    sourcemapFileName: "chunks/button.js.map",
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
  }: { serverReferences?: string[]; consumer?: "client" | "server" } = {},
) {
  const metaMap = new Map(serverReferences.map((id) => [id, {}]));
  const plugin = createServerActionClientSourcemapPlugin({
    getManager: async () => ({ serverReferences: { metaMap } }) as never,
  });
  const context = { environment: { name: consumer, config: { consumer } } };
  (plugin.configResolved as (config: unknown) => void)({});
  (plugin.buildStart as (this: unknown) => void).call(context);
  for (const [id, code] of Object.entries(MODULES)) {
    (plugin.transform as Hook).handler.call(context, code as never, id as never);
  }
  await (plugin.generateBundle as Hook).handler.call(context, {} as never, bundle as never);
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
    const plugin = createServerActionClientSourcemapPlugin({ getManager: async () => undefined });
    expect(plugin.apply).toBe("build");
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

  it.each([
    ["chunks without server references", { serverReferences: [] as string[] }],
    ["server builds", { consumer: "server" as const }],
  ])("leaves maps unchanged for %s", async (_name, options) => {
    const bundle = await generate(withAsset(DEFAULT_MAP), options);
    expect(bundle["chunks/button.js.map"]!.source).toBe(JSON.stringify(DEFAULT_MAP));
  });
});
