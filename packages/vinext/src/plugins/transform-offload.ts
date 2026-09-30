/**
 * Runs vinext's pure whole-module AST transforms for large modules on a small
 * pool of worker threads.
 *
 * Builds are bound by the main thread, and mid-size server dependencies (e.g.
 * `esprima`, `acorn` or the react-dom server builds) spend most of their
 * vinext plugin time being parsed by transforms that are pure functions of
 * their arguments. Inputs of at least
 * `OFFLOAD_MIN_SOURCE_LENGTH` characters run the same function on a worker;
 * smaller inputs stay inline, where a message round trip would cost more than
 * it saves. Callers apply each transform's cheap pre-parse check first, so only
 * inputs the transform will actually parse reach the pool, and an app whose
 * large modules all fail those checks never starts a worker.
 *
 * The pool is only an accelerator. Whenever it is unavailable (running from
 * source without a compiled worker entry, a single core, Bun or Deno,
 * `VINEXT_TRANSFORM_WORKERS=0`) or a worker fails, the transform runs
 * in-process. A transform that throws on the worker is re-run in-process so
 * the caller sees the same error. The one exception is stack depth: workers
 * get a larger stack than the main thread (see `WORKER_STACK_SIZE_MB`), so an
 * AST walk that overflows in-process can succeed on a worker.
 */
import fs from "node:fs";
import os from "node:os";
import { Worker } from "node:worker_threads";
import { SourceMap } from "magic-string";
import type { MagicStringTransformResult } from "./transform-result.js";
import type { PureTransformKind, PureTransforms } from "./transform-offload-worker.js";

const OFFLOAD_MIN_SOURCE_LENGTH = 128 * 1024;
const MAX_WORKERS = 2;
// Idle workers hold a parsed copy of vite; release them in long-lived dev and
// watch processes once large transforms stop arriving. The next large
// transform then waits a few hundred ms for a fresh worker to import vite,
// which is off the main thread.
const WORKER_IDLE_TIMEOUT_MS = 10_000;
// Worker threads default to a 4 MB stack, half the usual 8 MB main thread.
// vite's native `parseAst` recurses on the calling thread and overflowing it
// kills the process instead of throwing, so a default worker would crash on
// deeply nested modules the main thread parses fine. Leave headroom above 8 MB.
const WORKER_STACK_SIZE_MB = 16;
const DEFAULT_WORKER_URL = new URL("./transform-offload-worker.js", import.meta.url);

type PureTransformResult = MagicStringTransformResult | null;
/** A transform result, pending while the transform runs on a worker. */
export type PureTransformOutput = PureTransformResult | Promise<PureTransformResult>;
type PureTransformArgs = [code: string, ...rest: unknown[]];

export type PureTransformRequest = {
  id: number;
  kind: PureTransformKind;
  args: unknown[];
  sourcemap: boolean;
};

export type PureTransformResponse =
  | { id: number; result: { code: string; map?: SourceMap } | null }
  | { id: number; error: true };

export type PureTransformPool = {
  /**
   * Run `transform(...args)`, on a worker when `args[0]` (the module source)
   * is large. `kind` names the same function in the worker's registry. The
   * worker only serializes the sourcemap when `sourcemap` is set; reading
   * `map` from a result computed without one re-runs the transform in-process.
   */
  run<A extends PureTransformArgs>(
    kind: PureTransformKind,
    transform: (...args: A) => PureTransformResult,
    args: A,
    options: { sourcemap: boolean },
  ): PureTransformOutput;
  /** Terminate the workers; pending and later transforms run in-process. */
  close(): Promise<void>;
};

type PoolWorker = { worker: Worker; pending: number; idleTimer?: NodeJS.Timeout };

type PendingTask = {
  owner: PoolWorker;
  settle: (response: PureTransformResponse | undefined) => void;
};

export function createPureTransformPool(options: {
  workerUrl: URL;
  size: number;
  minSourceLength?: number;
}): PureTransformPool {
  const { workerUrl, size, minSourceLength = OFFLOAD_MIN_SOURCE_LENGTH } = options;
  const workers: PoolWorker[] = [];
  const tasks = new Map<number, PendingTask>();
  let available = size > 0;
  let nextTaskId = 0;

  function shutDown(): Promise<unknown> {
    available = false;
    const terminated = workers.splice(0).map((owner) => {
      clearTimeout(owner.idleTimer);
      return owner.worker.terminate();
    });
    for (const [id, task] of tasks) {
      tasks.delete(id);
      task.settle(undefined);
    }
    return Promise.all(terminated);
  }

  function retire(owner: PoolWorker): void {
    const index = workers.indexOf(owner);
    if (index === -1) return;
    workers.splice(index, 1);
    void owner.worker.terminate();
  }

  function acquire(owner: PoolWorker): void {
    if (owner.pending++ > 0) return;
    clearTimeout(owner.idleTimer);
    owner.worker.ref();
  }

  function release(owner: PoolWorker): void {
    if (--owner.pending > 0) return;
    // An idle worker must never keep the process alive.
    owner.worker.unref();
    owner.idleTimer = setTimeout(() => retire(owner), WORKER_IDLE_TIMEOUT_MS).unref();
  }

  function spawnWorker(): PoolWorker {
    const worker = new Worker(workerUrl, { resourceLimits: { stackSizeMb: WORKER_STACK_SIZE_MB } });
    const owner: PoolWorker = { worker, pending: 0 };
    worker.unref();
    worker.on("message", (response: PureTransformResponse) => {
      const task = tasks.get(response.id);
      if (!task) return;
      tasks.delete(response.id);
      release(owner);
      task.settle(response);
    });
    // A worker that fails to start, crashes, or exits on its own disables the
    // pool for the rest of the process. Retired and closed workers have
    // already left `workers`, so their exit is expected.
    const fail = () => {
      if (workers.includes(owner)) void shutDown();
    };
    worker.on("error", fail);
    worker.on("messageerror", fail);
    worker.on("exit", fail);
    workers.push(owner);
    return owner;
  }

  function pickWorker(): PoolWorker {
    const idle = workers.find((owner) => owner.pending === 0);
    if (idle) return idle;
    if (workers.length < size) return spawnWorker();
    return workers.reduce((least, owner) => (owner.pending < least.pending ? owner : least));
  }

  return {
    run(kind, transform, args, { sourcemap }) {
      if (!available || args[0].length < minSourceLength) return transform(...args);
      let owner: PoolWorker;
      try {
        owner = pickWorker();
      } catch {
        void shutDown();
        return transform(...args);
      }

      return new Promise<PureTransformResult>((resolve, reject) => {
        const runInProcess = () => {
          try {
            resolve(transform(...args));
          } catch (error) {
            reject(error);
          }
        };
        const id = nextTaskId++;
        tasks.set(id, {
          owner,
          settle(response) {
            if (!response || "error" in response) runInProcess();
            else resolve(response.result && workerResult(response.result, transform, args));
          },
        });
        acquire(owner);
        try {
          const request: PureTransformRequest = { id, kind, args, sourcemap };
          owner.worker.postMessage(request);
        } catch {
          tasks.delete(id);
          release(owner);
          runInProcess();
        }
      });
    },
    async close() {
      await shutDown();
    },
  };
}

function workerResult<A extends PureTransformArgs>(
  result: { code: string; map?: SourceMap },
  transform: (...args: A) => PureTransformResult,
  args: A,
): MagicStringTransformResult {
  // Structured clone drops the class; restore it so `toString()`/`toUrl()`
  // behave exactly like an in-process result.
  if (result.map) Object.setPrototypeOf(result.map, SourceMap.prototype);
  let map = result.map;
  return {
    code: result.code,
    get map() {
      // The transform is pure, so an in-process run yields the same result.
      map ??= transform(...args)!.map;
      return map;
    },
  };
}

/**
 * Worker count for the shared pool: one core stays with the main thread, and
 * `VINEXT_TRANSFORM_WORKERS=0` disables offloading.
 */
export function resolvePureTransformWorkerCount(): number {
  if (process.env.VINEXT_TRANSFORM_WORKERS === "0") return 0;
  // Bun ignores `resourceLimits.stackSizeMb` (and Deno's support is unclear),
  // so their workers crash on deeply nested modules; see `WORKER_STACK_SIZE_MB`.
  if (process.versions.bun || process.versions.deno) return 0;
  return Math.max(0, Math.min(MAX_WORKERS, os.availableParallelism() - 1));
}

let sharedPool: PureTransformPool | undefined;

function getSharedPool(): PureTransformPool {
  sharedPool ??= createPureTransformPool({
    workerUrl: DEFAULT_WORKER_URL,
    // When vinext runs from source (e.g. the test suite transpiling `.ts` on
    // the fly) there is no compiled worker entry to start.
    size: fs.existsSync(DEFAULT_WORKER_URL) ? resolvePureTransformWorkerCount() : 0,
  });
  return sharedPool;
}

/**
 * Run a pure transform registered in `transform-offload-worker.ts` on the
 * process-wide worker pool when its input is large, otherwise inline. Returns
 * a promise only for offloaded inputs, so small modules stay synchronous.
 * Apply the transform's cheap pre-parse check first: an input it rejects would
 * cost a worker round trip, or start a worker, for no work.
 */
export function runPureTransform<K extends PureTransformKind>(
  kind: K,
  transform: PureTransforms[K],
  args: Parameters<PureTransforms[K]>,
  options: { sourcemap: boolean },
): PureTransformOutput {
  // The signature ties `transform` and `args` to the worker's entry for `kind`.
  const run = transform as (...args: PureTransformArgs) => PureTransformResult;
  const input = args as PureTransformArgs;
  if (input[0].length < OFFLOAD_MIN_SOURCE_LENGTH) return run(...input);
  return getSharedPool().run(kind, run, input, options);
}
