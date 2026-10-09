import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createWorkerUseServerPlugins } from "../packages/vinext/src/plugins/worker-use-server.js";

type UnknownHook = (...args: never[]) => unknown;

function hookHandler(hook: unknown): UnknownHook {
  if (typeof hook === "function") return hook as UnknownHook;
  if (hook && typeof hook === "object") {
    const handler = Reflect.get(hook, "handler");
    if (typeof handler === "function") return handler as UnknownHook;
  }
  throw new Error("Expected plugin hook");
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function createUseServerPlugin(): Promise<Plugin> {
  const rscPluginPath = createRequire(
    path.resolve(import.meta.dirname, "../packages/vinext/package.json"),
  ).resolve("@vitejs/plugin-rsc");
  const manager = { serverReferences: { resolve: () => ({ referenceKey: "worker-key" }) } };
  const plugins = await createWorkerUseServerPlugins({
    rscPluginModule: Promise.resolve({ getPluginApi: () => ({ manager }) } as never),
    rscPluginPath,
  });
  const plugin = plugins.find((candidate) => candidate.name === "vinext:worker-use-server")!;
  await hookHandler(plugin.configResolved).call(undefined as never, {} as never);
  return plugin;
}

describe("worker Server Function references", () => {
  it("watches export-all targets whose edges the proxy removes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-worker-use-server-"));
    tmpDirs.push(root);
    const implPath = path.join(root, "impl.ts");
    fs.writeFileSync(implPath, "export async function keyLength() { return 1; }\n");
    const plugin = await createUseServerPlugin();
    const addWatchFile = vi.fn();
    const transform = hookHandler(plugin.transform) as unknown as (
      this: object,
      code: string,
      id: string,
    ) => Promise<{ code: string } | null>;

    const result = await transform.call(
      {
        addWatchFile,
        error: (message: string) => {
          throw new Error(message);
        },
        resolve: async () => ({ id: implPath }),
      },
      '"use server";\nexport * from "./impl";\n',
      path.join(root, "actions.ts"),
    );

    expect(addWatchFile).toHaveBeenCalledWith(implPath);
    expect(result?.code).toContain('"worker-key#keyLength"');
    expect(result?.code).not.toContain("./impl");
  });
});
