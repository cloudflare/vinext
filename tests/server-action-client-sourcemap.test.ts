import { describe, expect, it } from "vite-plus/test";
import { createServerActionClientSourcemapPlugin } from "../packages/vinext/src/plugins/server-action-client-sourcemap.js";

type Hook = { handler: (this: unknown, ...args: never[]) => unknown };
type Bundle = Record<string, Record<string, unknown>>;

const OUT_DIR = "/app/dist/client";
const ACTION_ID = "/app/app/actions.ts";
const CLIENT_ID = "/app/app/button.tsx";
const ACTION_SOURCE = '"use server";\nexport async function save() { return "PRIVATE"; }\n';
const CLIENT_SOURCE = '"use client";\nexport function Button() {}\n';
const MAP_PREFIX = "../../../../..";

function sourcemap(sources: string[], sourcesContent: string[]) {
  return JSON.stringify({ version: 3, sources, sourcesContent, mappings: "" });
}

function chunk(code = "export{};") {
  return {
    type: "chunk",
    fileName: "_next/static/chunks/button.js",
    sourcemapFileName: "_next/static/chunks/button.js.map",
    moduleIds: [ACTION_ID, CLIENT_ID],
    code,
  };
}

async function generate(
  bundle: Bundle,
  {
    serverReferences = [ACTION_ID],
    consumer = "client",
    outputOptions = {},
  }: {
    serverReferences?: string[];
    consumer?: "client" | "server";
    outputOptions?: Record<string, unknown>;
  } = {},
) {
  const metaMap = new Map(serverReferences.map((id) => [id, {}]));
  const plugin = createServerActionClientSourcemapPlugin({
    getManager: async () => ({ serverReferences: { metaMap } }) as never,
  });
  (plugin.configResolved as (config: unknown) => void)({});
  await (plugin.generateBundle as Hook).handler.call(
    { environment: { config: { consumer } } },
    { dir: OUT_DIR, ...outputOptions } as never,
    bundle as never,
  );
  return bundle;
}

const defaultMap = sourcemap(
  [`${MAP_PREFIX}/app/actions.ts`, `${MAP_PREFIX}/app/button.tsx`],
  [ACTION_SOURCE, CLIENT_SOURCE],
);

function mapAsset(bundle: Bundle) {
  return JSON.parse(String(bundle["_next/static/chunks/button.js.map"]!.source));
}

describe("vinext:server-action-client-sourcemap", () => {
  it("only runs in builds", () => {
    const plugin = createServerActionClientSourcemapPlugin({ getManager: async () => undefined });
    expect(plugin.apply).toBe("build");
  });

  it("nulls server action content in emitted .map assets", async () => {
    const bundle = await generate({
      "_next/static/chunks/button.js": chunk(),
      "_next/static/chunks/button.js.map": { type: "asset", source: defaultMap },
    });
    expect(mapAsset(bundle).sources).toEqual([
      `${MAP_PREFIX}/app/actions.ts`,
      `${MAP_PREFIX}/app/button.tsx`,
    ]);
    expect(mapAsset(bundle).sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it("nulls it in inline maps", async () => {
    const encoded = Buffer.from(defaultMap).toString("base64");
    const bundle = await generate({
      "_next/static/chunks/button.js": chunk(
        `export{};\n//# sourceMappingURL=data:application/json;base64,${encoded}\n`,
      ),
    });
    const code = String(bundle["_next/static/chunks/button.js"]!.code);
    const inline = /base64,([A-Za-z0-9+/=]+)\n$/.exec(code)![1]!;
    expect(JSON.parse(Buffer.from(inline, "base64").toString("utf8")).sourcesContent).toEqual([
      null,
      CLIENT_SOURCE,
    ]);
  });

  it("nulls sources a loader-supplied map names differently", async () => {
    const map = sourcemap(
      [`${MAP_PREFIX}/app/original/actions.ts`, `${MAP_PREFIX}/app/button.tsx`],
      [ACTION_SOURCE, CLIENT_SOURCE],
    );
    const bundle = await generate({
      "_next/static/chunks/button.js": chunk(),
      "_next/static/chunks/button.js.map": { type: "asset", source: map },
    });
    expect(mapAsset(bundle).sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it("keeps sources rewritten by sourcemapPathTransform", async () => {
    const map = sourcemap(
      [`src://${MAP_PREFIX}/app/actions.ts`, `src://${MAP_PREFIX}/app/button.tsx`],
      [ACTION_SOURCE, CLIENT_SOURCE],
    );
    const bundle = await generate(
      {
        "_next/static/chunks/button.js": chunk(),
        "_next/static/chunks/button.js.map": { type: "asset", source: map },
      },
      { outputOptions: { sourcemapPathTransform: (source: string) => `src://${source}` } },
    );
    expect(mapAsset(bundle).sourcesContent).toEqual([null, CLIENT_SOURCE]);
  });

  it.each([
    ["chunks without server references", { serverReferences: [] as string[] }],
    ["server builds", { consumer: "server" as const }],
  ])("leaves maps unchanged for %s", async (_name, options) => {
    const bundle = await generate(
      {
        "_next/static/chunks/button.js": chunk(),
        "_next/static/chunks/button.js.map": { type: "asset", source: defaultMap },
      },
      options,
    );
    expect(bundle["_next/static/chunks/button.js.map"]!.source).toBe(defaultMap);
  });
});
