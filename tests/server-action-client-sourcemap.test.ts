import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createServerActionClientSourcemapPlugin } from "../packages/vinext/src/plugins/server-action-client-sourcemap.js";

type LoadHandler = (this: unknown, id: string) => Promise<unknown>;

const plugin = createServerActionClientSourcemapPlugin();
const load = (plugin.load as { handler: LoadHandler }).handler;

function loadIn(id: string, consumer: "client" | "server", build: Record<string, unknown>) {
  return load.call({ environment: { config: { consumer, build } } }, id);
}

let root: string;
let actionFile: string;
let clientFile: string;
const actionSource = '// actions\n"use server";\nexport async function save() {}\n';

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-action-sourcemap-"));
  actionFile = path.join(root, "actions.ts");
  clientFile = path.join(root, "button.tsx");
  await fs.writeFile(actionFile, actionSource);
  await fs.writeFile(clientFile, '"use client";\nexport function Button() {}\n');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("vinext:server-action-client-sourcemap", () => {
  it("only runs in builds", () => {
    expect(plugin.apply).toBe("build");
  });

  it.each([
    { sourcemap: true },
    { sourcemap: "hidden" },
    { sourcemap: "inline" },
    { sourcemap: false, rolldownOptions: { output: { sourcemap: true } } },
    { rolldownOptions: { output: [{}, { sourcemap: "hidden" }] } },
  ])('loads client "use server" modules without their source map (%o)', async (build) => {
    await expect(loadIn(actionFile, "client", build)).resolves.toEqual({
      code: actionSource,
      map: { mappings: "" },
    });
  });

  it("leaves other modules, server builds and map-less client builds to the default loader", async () => {
    await expect(loadIn(clientFile, "client", { sourcemap: true })).resolves.toBeNull();
    await expect(loadIn(actionFile, "server", { sourcemap: true })).resolves.toBeNull();
    await expect(loadIn(actionFile, "client", { sourcemap: false })).resolves.toBeNull();
    await expect(
      loadIn(path.join(root, "missing.ts"), "client", { sourcemap: true }),
    ).resolves.toBeNull();
  });
});
