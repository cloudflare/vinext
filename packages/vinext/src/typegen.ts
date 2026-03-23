import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Temporary bridge for route-aware type generation.
 *
 * Vinext should eventually generate these types from its own route tree
 * instead of delegating to `next typegen`, but this improves dev-time DX in
 * the meantime without making Next.js a hard requirement for startup.
 *
 * Tracking issue: https://github.com/cloudflare/vinext/issues/664
 */
export interface NextTypegenControllerOptions {
  root: string;
  enabled?: boolean;
  debounceMs?: number;
  logger?: Pick<Console, "info" | "warn">;
  resolveNextBin?: (root: string) => string | null;
  spawnImpl?: typeof spawn;
}

export interface NextTypegenController {
  start(): void;
  schedule(): void;
  close(): void;
}

export function resolveNextTypegenBin(root: string): string | null {
  try {
    const projectRequire = createRequire(path.join(root, "package.json"));
    return projectRequire.resolve("next/dist/bin/next");
  } catch {
    return null;
  }
}

export function createNextTypegenController(
  options: NextTypegenControllerOptions,
): NextTypegenController {
  const {
    root,
    enabled = true,
    debounceMs = 150,
    logger = console,
    resolveNextBin = resolveNextTypegenBin,
    spawnImpl = spawn,
  } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let child: ChildProcess | null = null;
  let pending = false;
  let nextBin: string | null | undefined;
  let missingNextLogged = false;
  let closed = false;

  function getNextBin(): string | null {
    if (nextBin !== undefined) return nextBin;
    nextBin = resolveNextBin(root);
    if (!nextBin && !missingNextLogged) {
      missingNextLogged = true;
      logger.info("[vinext] Skipping dev typegen: `next` is not installed in this project.");
    }
    return nextBin;
  }

  function run(): void {
    if (!enabled || closed) return;

    const resolvedNextBin = getNextBin();
    if (!resolvedNextBin) return;

    if (child) {
      pending = true;
      return;
    }

    child = spawnImpl(process.execPath, [resolvedNextBin, "typegen"], {
      cwd: root,
      stdio: "ignore",
      env: process.env,
    });

    child.once("error", (error) => {
      logger.warn(`[vinext] Failed to run \`next typegen\`: ${error.message}`);
    });

    child.once("exit", (code, signal) => {
      child = null;

      if (closed) return;

      if (code !== 0) {
        const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
        logger.warn(`[vinext] \`next typegen\` exited with ${detail}.`);
      }

      if (pending) {
        pending = false;
        run();
      }
    });
  }

  function scheduleWithDelay(delayMs: number): void {
    if (!enabled || closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  }

  return {
    start() {
      scheduleWithDelay(0);
    },
    schedule() {
      scheduleWithDelay(debounceMs);
    },
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (child) {
        child.kill();
        child = null;
      }
    },
  };
}
