import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { createIgnoreDynamicRequestsPlugin } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";
import { createImportMetaUrlPlugin } from "../packages/vinext/src/plugins/import-meta-url.js";
import { runPureTransform } from "../packages/vinext/src/plugins/transform-offload.js";

// Resolve every pure transform asynchronously, as an offloaded input does.
vi.mock("../packages/vinext/src/plugins/transform-offload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/vinext/src/plugins/transform-offload.js")>()),
  runPureTransform: vi.fn(
    async (_kind: string, transform: (...args: unknown[]) => unknown, args: unknown[]) =>
      transform(...args),
  ),
}));

type TransformHandler = (this: unknown, code: string, id: string) => unknown;

function unwrapHook(hook: unknown): TransformHandler {
  const handler = typeof hook === "function" ? hook : (hook as { handler?: unknown })?.handler;
  if (typeof handler !== "function") throw new Error("transform hook not found");
  return handler as TransformHandler;
}

function environment(mode: "build" | "dev", sourcemap: boolean, extra: object = {}) {
  return { environment: { mode, config: { consumer: "server", build: { sourcemap }, ...extra } } };
}

let root: string;
let dependencyId: string;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vinext-offload-plugins-")));
  const dependencyDir = path.join(root, "node_modules", "offload-dependency");
  dependencyId = path.join(dependencyDir, "index.js");
  fs.mkdirSync(dependencyDir, { recursive: true });
  fs.writeFileSync(path.join(dependencyDir, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(dependencyId, "export const url = import.meta.url;\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(runPureTransform).mockClear();
});

describe("offloaded transform results in plugins", () => {
  it("ignore-dynamic-requests awaits the result and drops unused build sourcemaps", async () => {
    const transform = unwrapHook(createIgnoreDynamicRequestsPlugin().transform);
    const code = "export const load = (name) => require(name);";
    const id = path.join(root, "node_modules", "pkg", "index.js");

    const built = transform.call(environment("build", false), code, id);
    expect(built).toBeInstanceOf(Promise);
    await expect(built).resolves.toEqual({ code: expect.stringContaining("throw"), map: null });
    expect(runPureTransform).toHaveBeenLastCalledWith(
      "ignore-dynamic-requests",
      expect.any(Function),
      [code, id],
      { sourcemap: false },
    );

    // The pending result is cached and reused by environments that keep maps.
    const dev = (await transform.call(environment("dev", true), code, id)) as {
      map: { mappings: string } | null;
    };
    expect(runPureTransform).toHaveBeenCalledOnce();
    expect(dev.map?.mappings).toBeTruthy();
  });

  it("ignore-dynamic-requests does not send modules its pre-parse check rejects", () => {
    const transform = unwrapHook(createIgnoreDynamicRequestsPlugin().transform);
    const id = path.join(root, "node_modules", "pkg", "index.js");

    expect(
      transform.call(environment("build", false), 'export const fs = require("fs");', id),
    ).toBeNull();
    expect(runPureTransform).not.toHaveBeenCalled();
  });

  it("import-meta-url awaits server dependency and optimizer results", async () => {
    const capability = createImportMetaUrlPlugin({ getRoot: () => root });
    const code = "export const url = import.meta.url;";

    const built = unwrapHook(capability.vitePlugin.transform).call(
      environment("build", false),
      code,
      dependencyId,
    );
    expect(built).toBeInstanceOf(Promise);
    await expect(built).resolves.toEqual({
      code: expect.not.stringContaining("import.meta.url"),
      map: null,
    });
    expect(runPureTransform).toHaveBeenLastCalledWith(
      "import-meta-url",
      expect.any(Function),
      [code, expect.objectContaining({ id: dependencyId })],
      { sourcemap: false },
    );

    const optimized = unwrapHook(capability.optimizeDepsPlugin.transform).call(
      {},
      code,
      dependencyId,
    );
    expect(optimized).toBeInstanceOf(Promise);
    await expect(optimized).resolves.toMatchObject({
      code: expect.not.stringContaining("import.meta.url"),
    });
    expect(runPureTransform).toHaveBeenLastCalledWith(
      "import-meta-url",
      expect.any(Function),
      [code, expect.objectContaining({ id: dependencyId })],
      { sourcemap: true },
    );
  });

  it("typeof-window-scan awaits the result and drops unused build sourcemaps", async () => {
    const builder = await createBuilder({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [vinext({ react: false, rsc: false })],
    });
    const plugin = builder.config.plugins.find(
      (candidate) => candidate.name === "vinext:typeof-window-scan",
    );
    const transform = unwrapHook(plugin?.transform);
    const code = 'if (typeof window !== "undefined") import("browser-only");';
    const id = path.join(root, "app", "page.js");
    const scan = environment("build", false, {
      build: { write: false, sourcemap: false },
      cacheDir: path.join(root, ".vite"),
    });

    // Admitted by the hook's code filter, but its pre-parse check rejects it.
    expect(transform.call(scan, "export const env = process /* node */.env;", id)).toBeNull();
    expect(runPureTransform).not.toHaveBeenCalled();

    const scanned = transform.call(scan, code, id);
    expect(scanned).toBeInstanceOf(Promise);
    await expect(scanned).resolves.toEqual({
      code: expect.not.stringContaining("browser-only"),
      map: null,
    });
    expect(runPureTransform).toHaveBeenLastCalledWith(
      "typeof-window",
      expect.any(Function),
      [
        code,
        expect.objectContaining({ typeofWindow: "undefined", pruneUnreachableImports: true }),
        id,
      ],
      { sourcemap: false },
    );
  });
});
