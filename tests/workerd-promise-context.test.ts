/**
 * workerd resumes a request awaiting a promise in that request's own context
 * only when the promise carries the tag of the request that created it. V8's
 * optimizing compilers allocate promises without the tag
 * (https://github.com/cloudflare/workerd/issues/8228), so once the function
 * that creates an isolate-shared load is compiled, every request joining the
 * load resumes in the request that settles it, where workerd rejects its I/O
 * with "Cannot perform I/O on behalf of a different request".
 *
 * Under real traffic the compiled function rarely meets a load that other
 * requests join, so the worker in fixtures/workerd-promise-context compiles it
 * with V8's natives syntax first. Only the real Workers runtime tags promises.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/workerd-promise-context");
const VINEXT_SRC = path.resolve(import.meta.dirname, "../packages/vinext/src");
const requireFromCloudflare = createRequire(
  path.resolve(import.meta.dirname, "../packages/cloudflare/package.json"),
);

// With Maglev off, %OptimizeFunctionOnNextCall() compiles with TurboFan, and
// %GetOptimizationStatus() sets this bit while the function runs that code.
const TURBOFANNED = 1 << 5;
// Only V8 parses natives syntax, so this module reaches workerd unbundled. A
// first compile can deoptimize on feedback the priming calls left incomplete;
// the next round compiles with the feedback that deoptimization recorded.
const V8_NATIVES_MODULE = `
export function optimize(fn, args) {
  for (let round = 0; round < 5; round++) {
    %PrepareFunctionForOptimization(fn);
    for (let i = 0; i < 20; i++) fn(...args());
    %OptimizeFunctionOnNextCall(fn);
    fn(...args());
    if (%GetOptimizationStatus(fn) & ${TURBOFANNED}) break;
  }
  return %GetOptimizationStatus(fn);
}
export function optimizationStatus(fn) {
  return %GetOptimizationStatus(fn);
}
`;

type MiniflareInstance = {
  ready: Promise<URL>;
  dispatchFetch(url: string, init?: RequestInit): Promise<Response>;
  dispose(): Promise<void>;
};

async function bundleWorker(): Promise<string> {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    resolve: {
      alias: {
        "vinext/shims": path.join(VINEXT_SRC, "shims"),
        "vinext/internal": VINEXT_SRC,
        "@vitejs/plugin-rsc/ssr": path.join(FIXTURE_DIR, "plugin-rsc-ssr.ts"),
      },
    },
    ssr: { noExternal: true, target: "webworker" },
    build: {
      ssr: path.join(FIXTURE_DIR, "worker.ts"),
      write: false,
      minify: false,
      rollupOptions: { external: ["./v8-natives.js", /^node:/] },
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const output of outputs) {
    if (!("output" in output)) continue;
    const chunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
    if (chunk && chunk.type === "chunk") return chunk.code;
  }
  throw new Error("The fixture worker produced no entry chunk");
}

describe("isolate-shared loads on the Cloudflare Workers runtime", () => {
  let worker: MiniflareInstance | undefined;

  beforeAll(async () => {
    const code = await bundleWorker();
    const { Miniflare } = (await import(
      pathToFileURL(requireFromCloudflare.resolve("miniflare")).href
    )) as { Miniflare: new (options: object) => MiniflareInstance };
    const previousFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
    process.env.MINIFLARE_WORKERD_V8_FLAGS = "--allow-natives-syntax --no-maglev";
    try {
      worker = new Miniflare({
        workers: [
          {
            name: "main",
            modules: [
              { type: "ESModule", path: "worker.js", contents: code },
              { type: "ESModule", path: "v8-natives.js", contents: V8_NATIVES_MODULE },
            ],
            compatibilityDate: "2026-07-07",
            compatibilityFlags: ["nodejs_compat"],
            serviceBindings: { UPSTREAM: "upstream" },
          },
          {
            name: "upstream",
            modules: true,
            script: "export default { fetch: () => new Response('upstream ok') };",
            compatibilityDate: "2026-07-07",
          },
        ],
      });
      await worker.ready;
    } finally {
      if (previousFlags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
      else process.env.MINIFLARE_WORKERD_V8_FLAGS = previousFlags;
    }
  }, 120_000);

  afterAll(async () => {
    await worker?.dispose();
  });

  async function get(pathname: string, scenario: string): Promise<Response> {
    return worker!.dispatchFetch(`http://worker${pathname}?scenario=${scenario}`);
  }

  it.each(["routeModules", "serverReferences", "clientReferences"])(
    "resumes each request joining a %s load in its own context",
    async (scenario) => {
      const start = get("/start", scenario);
      while ((await (await get("/started", scenario)).text()) !== "true") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const joins = [0, 1].map(async () => {
        const response = await get("/join", scenario);
        return `${response.status} ${(await response.text()).split("\n")[0]}`;
      });

      const started = (await (await start).json()) as {
        primed: number;
        status: number;
        joined: number;
      };
      // TurboFan code created the shared promise, and both requests joined it.
      expect(started.primed & TURBOFANNED).toBe(TURBOFANNED);
      expect(started.status & TURBOFANNED).toBe(TURBOFANNED);
      expect(started.joined).toBe(2);
      expect(await Promise.all(joins)).toEqual(["200 upstream ok", "200 upstream ok"]);
    },
    30_000,
  );
});
