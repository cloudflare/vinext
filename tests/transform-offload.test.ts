import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { transformVeryDynamicRequests } from "../packages/vinext/src/plugins/ignore-dynamic-requests.js";
import { rewriteModuleIdentity } from "../packages/vinext/src/plugins/import-meta-url.js";
import {
  createPureTransformPool,
  resolvePureTransformWorkerCount,
  runPureTransform,
  type PureTransformPool,
} from "../packages/vinext/src/plugins/transform-offload.js";
import { replaceConsumerEnvironmentConditions } from "../packages/vinext/src/plugins/typeof-window.js";

const WORKER_SOURCE = path.resolve(
  import.meta.dirname,
  "../packages/vinext/src/plugins/transform-offload-worker.ts",
);
const OFFLOAD_MIN_SOURCE_LENGTH = 128 * 1024;
const DEPENDENCY_ID = path.resolve("/app/node_modules/pkg/index.js");

let tempDir: string;
let sourceWorkerUrl: URL;
// Runs the real transforms; shared because each worker imports vite.
let sourcePool: PureTransformPool;
const pools: PureTransformPool[] = [];

function writeWorker(name: string, source: string): URL {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, source);
  return pathToFileURL(file);
}

function createPool(workerUrl: URL, minSourceLength = 0): PureTransformPool {
  const pool = createPureTransformPool({ workerUrl, size: 2, minSourceLength });
  pools.push(pool);
  return pool;
}

function padToOffloadSize(code: string): string {
  return `${code}\n/*${"x".repeat(OFFLOAD_MIN_SOURCE_LENGTH)}*/\n`;
}

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-transform-offload-"));
  // vinext ships a compiled worker entry. From source, Node strips the
  // TypeScript and this hook maps the source tree's `.js` specifiers to `.ts`.
  sourceWorkerUrl = writeWorker(
    "source-worker.mjs",
    `
      import { registerHooks } from "node:module";
      registerHooks({
        resolve(specifier, context, nextResolve) {
          try {
            return nextResolve(specifier, context);
          } catch (error) {
            if (error?.code !== "ERR_MODULE_NOT_FOUND" || !/^\\.\\.?\\/.*\\.js$/.test(specifier)) {
              throw error;
            }
            return nextResolve(specifier.slice(0, -3) + ".ts", context);
          }
        },
      });
      await import(${JSON.stringify(pathToFileURL(WORKER_SOURCE).href)});
    `,
  );
  sourcePool = createPureTransformPool({ workerUrl: sourceWorkerUrl, size: 2, minSourceLength: 0 });
});

afterAll(async () => {
  await sourcePool.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("pure transform offloading", () => {
  const cases = [
    {
      kind: "ignore-dynamic-requests",
      transform: transformVeryDynamicRequests,
      args: [
        [
          "const load = (name) => require(name);",
          "const fixed = require(String.fromCharCode(102, 115));",
          "export const lazy = (name) => import(name);",
        ].join("\n"),
        DEPENDENCY_ID,
      ],
    },
    {
      kind: "import-meta-url",
      transform: rewriteModuleIdentity,
      args: [
        [
          '"use strict";',
          "const here = new URL(import.meta.url);",
          "module.exports = { here, dir: __dirname, file: __filename };",
        ].join("\n"),
        {
          id: DEPENDENCY_ID,
          importMetaUrlReplacement: JSON.stringify(pathToFileURL(DEPENDENCY_ID).href),
          cjsGlobalInitializers: {
            __filename: JSON.stringify(DEPENDENCY_ID),
            __dirname: JSON.stringify(path.dirname(DEPENDENCY_ID)),
          },
        },
      ],
    },
    {
      kind: "typeof-window",
      transform: replaceConsumerEnvironmentConditions,
      args: [
        [
          'if (typeof window !== "undefined") import("./browser.js");',
          'else import("./server.js");',
          "export const isBrowser = process.browser;",
        ].join("\n"),
        { typeofWindow: "undefined", processBrowser: false, pruneUnreachableImports: true },
        "/app/page.tsx",
      ],
    },
  ] as const;

  it.each(cases)("returns the in-process $kind result from a worker", async (testCase) => {
    const { kind, args } = testCase;
    const transform = testCase.transform as (
      ...args: unknown[]
    ) => ReturnType<typeof testCase.transform>;
    const expected = transform(...args);
    expect(expected).not.toBeNull();
    const inProcess = vi.fn(transform);

    const pending = sourcePool.run(kind, inProcess, [...args] as [string, ...unknown[]], {
      sourcemap: true,
    });
    expect(pending).toBeInstanceOf(Promise);
    const result = await pending;

    expect(result?.code).toBe(expected?.code);
    // Same class and fields as the in-process magic-string SourceMap.
    expect(result?.map).toStrictEqual(expected?.map);
    expect(result?.map.toString()).toBe(expected?.map.toString());
    // Neither the code nor the requested map was computed on the main thread.
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("returns null from a worker when the transform does not apply", async () => {
    const inProcess = vi.fn(transformVeryDynamicRequests);

    await expect(
      sourcePool.run("ignore-dynamic-requests", inProcess, ['require("fs");', DEPENDENCY_ID], {
        sourcemap: true,
      }),
    ).resolves.toBeNull();
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("parses deeply nested modules the main thread parses", async () => {
    // Nesting deep enough to overflow vite's native parser on a worker's
    // default 4 MB stack, which kills the process instead of throwing.
    const depth = 2_500;
    const args = [
      `const load = (name) => require(name);\nexport const value = ${"(".repeat(depth)}1${")".repeat(depth)};`,
      DEPENDENCY_ID,
    ] as const;
    const expected = transformVeryDynamicRequests(...args);
    expect(expected).not.toBeNull();
    const inProcess = vi.fn(transformVeryDynamicRequests);

    const result = await sourcePool.run("ignore-dynamic-requests", inProcess, [...args], {
      sourcemap: false,
    });

    expect(result?.code).toBe(expected?.code);
    expect(inProcess).not.toHaveBeenCalled();
  });

  it("computes an omitted sourcemap in-process on first read", async () => {
    const args = ["const load = (name) => require(name);", DEPENDENCY_ID] as const;
    const expected = transformVeryDynamicRequests(...args);
    const inProcess = vi.fn(transformVeryDynamicRequests);

    const result = await sourcePool.run("ignore-dynamic-requests", inProcess, [...args], {
      sourcemap: false,
    });

    expect(result?.code).toBe(expected?.code);
    expect(inProcess).not.toHaveBeenCalled();
    expect(result?.map).toStrictEqual(expected?.map);
    expect(result?.map).toBe(result?.map);
    expect(inProcess).toHaveBeenCalledOnce();
  });

  it("offloads only sources at or above the size threshold", async () => {
    const workerUrl = writeWorker(
      "length-worker.mjs",
      `
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", ({ id, args }) =>
          parentPort.postMessage({ id, result: { code: String(args[0].length) } }),
        );
      `,
    );
    const inProcess = vi.fn(() => ({ code: "in-process", map: null as never }));
    const pool = createPureTransformPool({ workerUrl, size: 1 });
    pools.push(pool);
    const small = "x".repeat(OFFLOAD_MIN_SOURCE_LENGTH - 1);
    const large = "x".repeat(OFFLOAD_MIN_SOURCE_LENGTH);

    expect(pool.run("typeof-window", inProcess, [small], { sourcemap: true })).toEqual({
      code: "in-process",
      map: null,
    });
    expect(inProcess).toHaveBeenCalledOnce();

    const offloaded = pool.run("typeof-window", inProcess, [large], { sourcemap: true });
    expect(offloaded).toBeInstanceOf(Promise);
    expect((await offloaded)?.code).toBe(String(OFFLOAD_MIN_SOURCE_LENGTH));
    expect(inProcess).toHaveBeenCalledOnce();

    const custom = createPool(workerUrl, 10);
    expect(custom.run("typeof-window", inProcess, ["123456789"], { sourcemap: true })).toEqual({
      code: "in-process",
      map: null,
    });
    await expect(
      custom.run("typeof-window", inProcess, ["1234567890"], { sourcemap: true }),
    ).resolves.toMatchObject({ code: "10" });
  });

  it("re-runs a transform that fails on the worker in-process", async () => {
    const workerUrl = writeWorker(
      "failing-worker.mjs",
      `
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", ({ id }) => parentPort.postMessage({ id, error: true }));
      `,
    );
    const pool = createPool(workerUrl);
    const error = new Error("transform failed");

    await expect(
      pool.run(
        "typeof-window",
        () => {
          throw error;
        },
        ["source"],
        { sourcemap: true },
      ),
    ).rejects.toBe(error);

    const expected = { code: "transformed", map: null as never };
    await expect(
      pool.run("typeof-window", () => expected, ["source"], { sourcemap: true }),
    ).resolves.toBe(expected);
    // A transform error is not a worker failure: the pool stays in use.
    const next = pool.run("typeof-window", () => expected, ["source"], { sourcemap: true });
    expect(next).toBeInstanceOf(Promise);
    await expect(next).resolves.toBe(expected);
  });

  it("falls back in-process and stops offloading when a worker exits", async () => {
    const workerUrl = writeWorker(
      "exiting-worker.mjs",
      `
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", () => process.exit(1));
      `,
    );
    const pool = createPool(workerUrl);
    const expected = { code: "transformed", map: null as never };
    const inProcess = vi.fn(() => expected);

    await expect(
      pool.run("typeof-window", inProcess, ["source"], { sourcemap: true }),
    ).resolves.toBe(expected);
    expect(inProcess).toHaveBeenCalledOnce();
    expect(pool.run("typeof-window", inProcess, ["source"], { sourcemap: true })).toBe(expected);
  });

  it("falls back in-process when the worker cannot start", async () => {
    const pool = createPool(pathToFileURL(path.join(tempDir, "missing-worker.mjs")));
    const expected = { code: "transformed", map: null as never };

    await expect(
      pool.run("typeof-window", () => expected, ["source"], { sourcemap: true }),
    ).resolves.toBe(expected);
    expect(pool.run("typeof-window", () => expected, ["source"], { sourcemap: true })).toBe(
      expected,
    );
  });

  it("runs pending transforms in-process when the pool closes", async () => {
    const workerUrl = writeWorker(
      "silent-worker.mjs",
      `
        import { parentPort } from "node:worker_threads";
        parentPort.on("message", () => {});
      `,
    );
    const pool = createPool(workerUrl);
    const expected = { code: "transformed", map: null as never };

    const pending = pool.run("typeof-window", () => expected, ["source"], { sourcemap: true });
    await pool.close();

    await expect(pending).resolves.toBe(expected);
    expect(pool.run("typeof-window", () => expected, ["source"], { sourcemap: true })).toBe(
      expected,
    );
  });

  it("keeps one core for the main thread and honours VINEXT_TRANSFORM_WORKERS=0", () => {
    vi.stubEnv("VINEXT_TRANSFORM_WORKERS", undefined);
    const cores = vi.spyOn(os, "availableParallelism");

    cores.mockReturnValue(16);
    expect(resolvePureTransformWorkerCount()).toBe(2);
    cores.mockReturnValue(2);
    expect(resolvePureTransformWorkerCount()).toBe(1);
    cores.mockReturnValue(1);
    expect(resolvePureTransformWorkerCount()).toBe(0);

    cores.mockReturnValue(16);
    vi.stubEnv("VINEXT_TRANSFORM_WORKERS", "0");
    expect(resolvePureTransformWorkerCount()).toBe(0);
  });

  it.each(["bun", "deno"])(
    "does not offload under %s, whose workers ignore stackSizeMb",
    (runtime) => {
      vi.stubEnv("VINEXT_TRANSFORM_WORKERS", undefined);
      vi.spyOn(os, "availableParallelism").mockReturnValue(16);
      const versions = process.versions as Record<string, string | undefined>;
      versions[runtime] = "1.0.0";
      try {
        expect(resolvePureTransformWorkerCount()).toBe(0);
      } finally {
        delete versions[runtime];
      }
    },
  );

  it("runs inline without a pool", () => {
    const large = padToOffloadSize("const load = (name) => require(name);");
    const expected = transformVeryDynamicRequests(large, DEPENDENCY_ID);
    const pool = createPureTransformPool({ workerUrl: sourceWorkerUrl, size: 0 });
    pools.push(pool);

    const disabled = pool.run(
      "ignore-dynamic-requests",
      transformVeryDynamicRequests,
      [large, DEPENDENCY_ID],
      { sourcemap: true },
    );
    expect(disabled).not.toBeInstanceOf(Promise);
    expect((disabled as typeof expected)?.code).toBe(expected?.code);

    // Running vinext from source has no compiled worker entry to start.
    const fromSource = runPureTransform(
      "ignore-dynamic-requests",
      transformVeryDynamicRequests,
      [large, DEPENDENCY_ID],
      { sourcemap: true },
    );
    expect(fromSource).not.toBeInstanceOf(Promise);
    expect((fromSource as typeof expected)?.code).toBe(expected?.code);
  });

  it("sends large inputs to the shared pool when a compiled worker entry exists", async () => {
    // Pretend the compiled worker entry ships next to the module, and start
    // the source worker in its place.
    const started: import("node:worker_threads").Worker[] = [];
    vi.resetModules();
    vi.doMock("node:worker_threads", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:worker_threads")>();
      class SourceWorker extends actual.Worker {
        constructor(_url: string | URL, options?: import("node:worker_threads").WorkerOptions) {
          super(sourceWorkerUrl, options);
          started.push(this);
        }
      }
      return { ...actual, Worker: SourceWorker };
    });
    const existsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((file) =>
      String(file).endsWith("/transform-offload-worker.js") ? true : existsSync(file),
    );
    vi.spyOn(os, "availableParallelism").mockReturnValue(4);

    try {
      const offload = await import("../packages/vinext/src/plugins/transform-offload.js");
      const inProcess = vi.fn(transformVeryDynamicRequests);
      const small = "const load = (name) => require(name);";
      const large = padToOffloadSize(small);
      const expected = transformVeryDynamicRequests(large, DEPENDENCY_ID);

      const inline = offload.runPureTransform(
        "ignore-dynamic-requests",
        inProcess,
        [small, DEPENDENCY_ID],
        {
          sourcemap: true,
        },
      );
      expect(inline).not.toBeInstanceOf(Promise);
      expect(inProcess).toHaveBeenCalledOnce();
      expect(started).toHaveLength(0);

      inProcess.mockClear();
      const pending = offload.runPureTransform(
        "ignore-dynamic-requests",
        inProcess,
        [large, DEPENDENCY_ID],
        { sourcemap: true },
      );
      expect(pending).toBeInstanceOf(Promise);
      expect(started).toHaveLength(1);
      expect((await pending)?.code).toBe(expected?.code);
      expect(inProcess).not.toHaveBeenCalled();
    } finally {
      await Promise.all(started.map((worker) => worker.terminate()));
      vi.doUnmock("node:worker_threads");
      vi.resetModules();
    }
  });
});
