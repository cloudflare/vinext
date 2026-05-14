/**
 * Dev server lock file.
 *
 * Writes the running dev server's PID, port, and URL into a lock file at
 * `node_modules/.cache/vinext/dev-lock.json`. When a second `vinext dev`
 * process starts in the same project directory, it reads the lock file and
 * either fails with an actionable error or, if the previous process is dead,
 * takes over the lock.
 *
 * This is especially useful for AI coding agents, which frequently attempt to
 * start `vinext dev` without knowing a server is already running.
 *
 * Ported behaviorally from Next.js:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/build/lockfile.ts
 *
 * Differences vs Next.js:
 * - No native `flock()`. Next.js uses Rust SWC bindings for cross-platform
 *   advisory locking; vinext uses a JSON file plus a PID liveness check
 *   (`process.kill(pid, 0)`), which is good enough for the dev-server
 *   "another server is running" use case. Race conditions on lock acquisition
 *   are tolerated: at worst, two dev servers race and one fails to bind a port.
 * - Lock file lives in `node_modules/.cache/vinext/` instead of `.next/dev/`,
 *   matching vinext's existing convention of not maintaining a `.next` dir.
 */

import fs from "node:fs";
import path from "node:path";

const LOCK_DIR_RELATIVE = path.join("node_modules", ".cache", "vinext");
const LOCK_FILE_NAME = "dev-lock.json";

/**
 * Information about a running dev server, stored inside the lock file itself.
 */
export type DevServerInfo = {
  pid: number;
  port: number;
  hostname: string;
  appUrl: string;
  startedAt: number;
  /** Project directory the server is running in. Used to detect stale entries. */
  cwd: string;
};

export type DevLockfile = {
  /** Update the lock file contents (e.g. once the port is known after listen). */
  update(info: DevServerInfo): void;
  /** Release the lock — deletes the file. Safe to call multiple times. */
  release(): void;
  /** Absolute path to the lock file. */
  path: string;
};

/**
 * Returns the absolute path to the lock file for a given project root.
 */
export function getLockfilePath(root: string): string {
  return path.join(root, LOCK_DIR_RELATIVE, LOCK_FILE_NAME);
}

/**
 * Reads and parses the lock file at the given path. Returns `undefined` if the
 * file doesn't exist or can't be parsed.
 */
export function readLockfile(lockfilePath: string): DevServerInfo | undefined {
  let content: string;
  try {
    content = fs.readFileSync(lockfilePath, "utf-8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as DevServerInfo;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.port === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.appUrl === "string" &&
      typeof parsed.startedAt === "number" &&
      typeof parsed.cwd === "string"
    ) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true if a process with the given PID is running.
 *
 * Uses `process.kill(pid, 0)`, which sends a null signal — it doesn't actually
 * kill the process, it just checks if it exists. Throws `ESRCH` if the process
 * doesn't exist, or `EPERM` if it exists but we don't have permission to
 * signal it (in which case it's still running, just owned by someone else).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we lack permission — still alive.
    return code === "EPERM";
  }
}

/**
 * Writes the lock file with the given content. Creates the parent directory
 * if it doesn't exist.
 */
function writeLockfile(lockfilePath: string, info: DevServerInfo): void {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(info, null, 2));
}

export type FormatErrorOptions = {
  /** Existing server info from the lock file, if readable. */
  existing: DevServerInfo | undefined;
  /** Project directory the new (failing) process is trying to run in. */
  cwd: string;
  /** Path to the lock file. */
  lockfilePath: string;
};

/**
 * Format the error message printed when another dev server is already running.
 *
 * Matches Next.js' error layout so AI agents and CLIs can parse the same
 * `- PID: ` / `- Local: ` lines.
 */
export function formatAlreadyRunningError(opts: FormatErrorOptions): string {
  const { existing, cwd, lockfilePath } = opts;

  if (!existing) {
    return [
      "Another vinext dev server appears to be running in this directory.",
      "",
      `Stale lock file: ${path.relative(cwd, lockfilePath)}`,
      "Remove it manually if no server is running, then re-run `vinext dev`.",
    ].join("\n");
  }

  const killCommand =
    process.platform === "win32" ? `taskkill /PID ${existing.pid} /F` : `kill ${existing.pid}`;

  return [
    "Another vinext dev server is already running.",
    "",
    `- Local:        ${existing.appUrl}`,
    `- PID:          ${existing.pid}`,
    `- Dir:          ${existing.cwd}`,
    "",
    `You can access the existing server at ${existing.appUrl},`,
    `or run \`${killCommand}\` to stop it and start a new one.`,
  ].join("\n");
}

export type AcquireOptions = {
  /** Project root. Lock file goes in `<root>/node_modules/.cache/vinext/`. */
  root: string;
  /** Initial server info to write. Port/URL may be updated later via `update()`. */
  info: DevServerInfo;
  /**
   * If a lock file exists but its PID is dead, take over instead of failing.
   * Defaults to `true`. Set to `false` for testing.
   */
  takeOverStale?: boolean;
  /** Register `process.on('exit', release)`. Defaults to `true`. */
  unlockOnExit?: boolean;
};

export type AcquireSuccess = {
  ok: true;
  lockfile: DevLockfile;
};

export type AcquireFailure = {
  ok: false;
  /** The server info from the existing lock file, if readable. */
  existing: DevServerInfo | undefined;
  /** Absolute path to the lock file. */
  lockfilePath: string;
};

export type AcquireResult = AcquireSuccess | AcquireFailure;

/**
 * Try to acquire the dev lock file for the given project root.
 *
 * Returns `{ ok: true, lockfile }` on success — the caller should call
 * `lockfile.release()` on shutdown (or rely on the exit listener registered
 * via `unlockOnExit`).
 *
 * Returns `{ ok: false, existing, lockfilePath }` if another live dev server
 * already holds the lock.
 */
export function tryAcquireLockfile(opts: AcquireOptions): AcquireResult {
  const { root, info, takeOverStale = true, unlockOnExit = true } = opts;
  const lockfilePath = getLockfilePath(root);

  const existing = readLockfile(lockfilePath);
  if (existing) {
    const alive = isPidAlive(existing.pid);
    if (alive) {
      return { ok: false, existing, lockfilePath };
    }
    if (!takeOverStale) {
      return { ok: false, existing, lockfilePath };
    }
    // Existing entry is stale (dead PID). Fall through and overwrite.
  }

  writeLockfile(lockfilePath, info);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only delete if the file still points at us. If another process took
      // over the lock (e.g. after a crash), don't delete their entry.
      const current = readLockfile(lockfilePath);
      if (current && current.pid === info.pid) {
        fs.unlinkSync(lockfilePath);
      }
    } catch {
      // Best-effort cleanup.
    }
  };

  let exitListener: NodeJS.ExitListener | undefined;
  if (unlockOnExit) {
    exitListener = () => release();
    process.on("exit", exitListener);
  }

  const lockfile: DevLockfile = {
    path: lockfilePath,
    update(next: DevServerInfo): void {
      try {
        writeLockfile(lockfilePath, next);
      } catch {
        // Best-effort; not fatal.
      }
    },
    release(): void {
      release();
      if (exitListener) {
        process.off("exit", exitListener);
        exitListener = undefined;
      }
    },
  };

  return { ok: true, lockfile };
}
