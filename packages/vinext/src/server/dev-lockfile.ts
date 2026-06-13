/**
 * Dev server lock file.
 *
 * Writes the running dev server's PID, port, and URL into a lock file at
 * `<root>/.vinext/dev/lock.json`. When a second `vinext dev` process starts in
 * the same project directory, it reads the lock file and either fails with an
 * actionable error or, if the previous process is dead, takes over the lock.
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
 * - Lock file lives in `<root>/.vinext/dev/lock.json` (mirroring Next.js'
 *   `.next/dev/lock` layout). `.vinext/` is already used by the fonts plugin
 *   to cache self-hosted Google Fonts, so this re-uses the same project-local
 *   state directory rather than polluting `node_modules`.
 */

import fs from "node:fs";
import path from "node:path";
import { normalizePathSeparators } from "../utils/path.js";

const LOCK_DIR_RELATIVE = path.join(".vinext", "dev");
const LOCK_FILE_NAME = "lock.json";

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
 *
 * Mode `0o600` because the lock file contains a PID that, in principle, lets
 * other users on the machine send signals to this user's dev server.
 * Restricting reads is defense-in-depth: the PID is also discoverable via
 * `ps` and the port via `netstat`/`ss`, so this isn't load-bearing.
 */
function writeLockfile(lockfilePath: string, info: DevServerInfo): void {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(info, null, 2), { mode: 0o600 });
}

type FormatErrorOptions = {
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
 *
 * The `existing: undefined` branch below is defensive — `tryAcquireLockfile`
 * currently only returns `ok: false` with a defined `existing`, but the
 * formatter is exported and unit-tested separately, so it handles both shapes.
 */
export function formatAlreadyRunningError(opts: FormatErrorOptions): string {
  const { existing, cwd, lockfilePath } = opts;

  if (!existing) {
    // Defensive fallback. Not reachable from tryAcquireLockfile today.
    return [
      "Another vinext dev server appears to be running in this directory.",
      "",
      // Normalized so the message reads the same on every platform — this
      // output is meant to be parsed by AI agents and CLIs.
      `Stale lock file: ${normalizePathSeparators(path.relative(cwd, lockfilePath))}`,
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

type AcquireOptions = {
  /** Project root. Lock file goes in `<root>/.vinext/dev/lock.json`. */
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

type AcquireSuccess = {
  ok: true;
  lockfile: DevLockfile;
};

type AcquireFailure = {
  ok: false;
  /** The server info from the existing lock file, if readable. */
  existing: DevServerInfo | undefined;
  /** Absolute path to the lock file. */
  lockfilePath: string;
};

type AcquireResult = AcquireSuccess | AcquireFailure;

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

  // NB: there is a small TOCTOU window between readLockfile() above and
  // writeLockfile() here. Two processes starting simultaneously can both
  // pass the check and both write the lock file. This is intentionally
  // tolerated — the loser will fail to bind its port, producing a clear
  // error. A native flock() (the approach Next.js takes via Rust bindings)
  // would close the window, but it's not worth the complexity for a
  // dev-ergonomics feature.
  writeLockfile(lockfilePath, info);

  // Capture the owner PID once so release() always asks "is the file still
  // mine?" against the same identity, regardless of what update() writes
  // later. In practice the PID never changes between acquire and release,
  // but this makes the intent explicit and decouples release from update.
  const ownerPid = info.pid;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      // Only delete if the file still points at us. If another process took
      // over the lock (e.g. after a crash), don't delete their entry.
      const current = readLockfile(lockfilePath);
      if (current && current.pid === ownerPid) {
        fs.unlinkSync(lockfilePath);
      }
    } catch {
      // Best-effort cleanup.
    }
  };

  // The "exit" event fires once Node.js is about to exit — either gracefully
  // (event loop drained, explicit process.exit(), or after the default
  // SIGINT/SIGTERM handlers terminate the process). It does NOT fire on
  // uncaught exceptions or hard crashes (SIGKILL), which is fine: the next
  // `vinext dev` will detect the dead PID and take over the stale lock.
  //
  // If a future caller installs a custom signal handler that swallows
  // SIGINT/SIGTERM without exiting, the lock would leak — also fine, same
  // recovery path applies.
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
