import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServerActionClientSourcemapPlugin } from "../packages/vinext/src/plugins/server-action-client-sourcemap.js";

type LoadHook = { order?: string; handler: (this: unknown, id: string) => Promise<unknown> };

const plugin = createServerActionClientSourcemapPlugin();
const load = plugin.load as LoadHook;

function loadIn(id: string, consumer: "client" | "server" = "client") {
  return load.handler.call({ environment: { config: { consumer } } }, id);
}

let root: string;
const files = {
  action: '// actions\n"use server";\nexport async function save() {}\n',
  prologue: '"use strict" /* note */; "use server";\r\nexport async function save() {}\n',
  unparsable: '"use server";\nexport async function save( {\n',
  client: '"use client";\nexport function Button() {}\n',
  mention: 'export const label = "use server";\n',
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-action-sourcemap-"));
  for (const [name, source] of Object.entries(files)) {
    await fs.writeFile(path.join(root, `${name}.ts`), source);
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("vinext:server-action-client-sourcemap", () => {
  it("only runs in builds, after other loaders but before Vite's query-aware fallback", () => {
    expect(plugin.apply).toBe("build");
    expect(plugin.enforce).toBe("post");
    expect(load.order).toBeUndefined();
  });

  it.each(["action", "prologue", "unparsable"] as const)(
    'loads client "use server" modules without their source map (%s)',
    async (name) => {
      await expect(loadIn(path.join(root, `${name}.ts`))).resolves.toEqual({
        code: files[name],
        map: { mappings: "" },
      });
    },
  );

  it("reads query-suffixed module ids from the file", async () => {
    await expect(loadIn(path.join(root, "action.ts?v=1"))).resolves.toEqual({
      code: files.action,
      map: { mappings: "" },
    });
  });

  it("leaves other modules, server builds and missing files to the default loader", async () => {
    await expect(loadIn(path.join(root, "client.ts"))).resolves.toBeNull();
    await expect(loadIn(path.join(root, "mention.ts"))).resolves.toBeNull();
    await expect(loadIn(path.join(root, "action.ts"), "server")).resolves.toBeNull();
    await expect(loadIn(path.join(root, "missing.ts"))).resolves.toBeNull();
  });
});
