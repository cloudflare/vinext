/**
 * Tests for the dev server lock file.
 *
 * Behavior modeled on Next.js' dev lock file:
 *   https://github.com/vercel/next.js/blob/canary/packages/next/src/build/lockfile.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { toSlash } from "pathslash";

import {
  type DevServerInfo,
  formatAlreadyRunningError,
  getLockfilePath,
  isPidAlive,
  readLockfile,
  tryAcquireLockfile,
} from "../packages/vinext/src/server/dev-lockfile.js";

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-lockfile-"));
}

function cleanup(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function baseInfo(overrides: Partial<DevServerInfo> = {}): DevServerInfo {
  return {
    pid: process.pid,
    port: 3000,
    hostname: "localhost",
    appUrl: "http://localhost:3000",
    startedAt: Date.now(),
    cwd: "/tmp/example",
    ...overrides,
  };
}

describe("getLockfilePath", () => {
  it("places the lock file under .vinext/dev/", () => {
    const root = "/projects/my-app";
    expect(getLockfilePath(root)).toBe(
      toSlash(path.join("/projects/my-app", ".vinext", "dev", "lock.json")),
    );
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead pid", () => {
    // PID 0 / negative / non-integer are never valid.
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(Number.NaN)).toBe(false);
  });

  it("returns false for a very large unused pid", () => {
    // PIDs above the typical kernel max are extremely unlikely to exist.
    expect(isPidAlive(2_147_000_000)).toBe(false);
  });
});

describe("readLockfile", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it("returns undefined when the file doesn't exist", () => {
    expect(readLockfile(getLockfilePath(root))).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "{ not json");
    expect(readLockfile(lockPath)).toBeUndefined();
  });

  it("returns undefined for JSON missing required fields", () => {
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1 }));
    expect(readLockfile(lockPath)).toBeUndefined();
  });

  it("round-trips valid server info", () => {
    const info = baseInfo({ pid: 42, port: 4321 });
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(info));
    expect(readLockfile(lockPath)).toEqual(info);
  });
});

describe("tryAcquireLockfile", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    cleanup(root);
  });

  it("writes the lock file when none exists", () => {
    const info = baseInfo({ cwd: root });
    const result = tryAcquireLockfile({ root, info, unlockOnExit: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stored = readLockfile(getLockfilePath(root));
    expect(stored).toEqual(info);
    result.lockfile.release();
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("fails when an existing lock file references a live PID", () => {
    // Write a lock file pointing at the current (live) process.
    const existing = baseInfo({ pid: process.pid, cwd: root });
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(existing));

    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ pid: process.pid + 1, cwd: root }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.existing).toEqual(existing);
    expect(result.lockfilePath).toBe(lockPath);
  });

  it("takes over the lock when the existing entry is a dead PID", () => {
    // Use a definitely-dead pid (very large).
    const stale = baseInfo({ pid: 2_147_000_000, cwd: root });
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(stale));

    const info = baseInfo({ pid: process.pid, port: 4000, cwd: root });
    const result = tryAcquireLockfile({ root, info, unlockOnExit: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readLockfile(lockPath)).toEqual(info);
    result.lockfile.release();
  });

  it("does not take over stale entries when takeOverStale is false", () => {
    const stale = baseInfo({ pid: 2_147_000_000, cwd: root });
    const lockPath = getLockfilePath(root);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(stale));

    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root }),
      takeOverStale: false,
      unlockOnExit: false,
    });
    expect(result.ok).toBe(false);
  });

  it("update() rewrites the lock file contents", () => {
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root, port: 3000 }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const updated = baseInfo({ cwd: root, port: 5173, appUrl: "http://localhost:5173" });
    result.lockfile.update(updated);
    expect(readLockfile(getLockfilePath(root))).toEqual(updated);
    result.lockfile.release();
  });

  it("update() preserves startedAt when callers pass the original value", () => {
    // Documents the CLI contract: `startedAt` is meant to reflect when the
    // process started, not when the URL was resolved. The dev() command in
    // cli.ts captures startedAt at acquire time and passes the same value
    // into update() so the lock file's startedAt stays stable across the
    // pre-listen → post-listen rewrite.
    const startedAt = Date.now() - 60_000; // pretend the process started a minute ago
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root, port: 3000, startedAt }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lockfile.update(
      baseInfo({
        cwd: root,
        port: 5173,
        appUrl: "http://localhost:5173",
        startedAt, // caller's responsibility to thread this through
      }),
    );
    expect(readLockfile(getLockfilePath(root))?.startedAt).toBe(startedAt);
    result.lockfile.release();
  });

  it("release() is idempotent", () => {
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.lockfile.release();
    result.lockfile.release();
    expect(fs.existsSync(getLockfilePath(root))).toBe(false);
  });

  it("release() does not delete a lock file owned by a different PID", () => {
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root, pid: process.pid }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Simulate another process taking over.
    const lockPath = getLockfilePath(root);
    fs.writeFileSync(lockPath, JSON.stringify(baseInfo({ cwd: root, pid: process.pid + 12345 })));

    result.lockfile.release();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("release() ignores stale ownerPid even after update() rewrites with different info", () => {
    // Acquire with current PID, then update() with a different PID in the
    // payload. release() must still check against the *original* ownerPid
    // (the acquire-time PID), not the update-time PID. Without that guarantee
    // a malicious or buggy caller could trick release() into deleting another
    // process's lock by passing a fake PID through update().
    const lockPath = getLockfilePath(root);
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root, pid: process.pid }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Pretend update() was called with a different PID (simulating a future
    // bug or hostile caller). The lock file now claims to be owned by some
    // other PID.
    const otherPid = process.pid + 99999;
    result.lockfile.update(baseInfo({ cwd: root, pid: otherPid }));
    expect(readLockfile(lockPath)?.pid).toBe(otherPid);

    // release() must NOT delete the file, because ownerPid (captured at
    // acquire) doesn't match what's on disk.
    result.lockfile.release();
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("registers an exit listener when unlockOnExit is true and removes it on release()", () => {
    const before = process.listenerCount("exit");
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root }),
      unlockOnExit: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(process.listenerCount("exit")).toBe(before + 1);
    result.lockfile.release();
    expect(process.listenerCount("exit")).toBe(before);
  });

  it("registers no exit listener when unlockOnExit is false", () => {
    const before = process.listenerCount("exit");
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(process.listenerCount("exit")).toBe(before);
    result.lockfile.release();
  });

  it("write sets restrictive file permissions on POSIX", () => {
    // mode bits aren't meaningfully enforced on Windows, skip there.
    if (process.platform === "win32") return;
    const result = tryAcquireLockfile({
      root,
      info: baseInfo({ cwd: root }),
      unlockOnExit: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const stat = fs.statSync(getLockfilePath(root));
    // Only the user permission bits should be set; group/other should be 0.
    expect(stat.mode & 0o077).toBe(0);
    result.lockfile.release();
  });
});

describe("formatAlreadyRunningError", () => {
  it("includes PID, URL, and dir when existing info is available", () => {
    const existing = baseInfo({
      pid: 12345,
      port: 3000,
      appUrl: "http://localhost:3000",
      cwd: "/path/to/project",
    });
    const msg = formatAlreadyRunningError({
      existing,
      cwd: "/path/to/project",
      lockfilePath: "/path/to/project/.vinext/dev/lock.json",
    });
    expect(msg).toContain("Another vinext dev server is already running");
    expect(msg).toContain("- Local:        http://localhost:3000");
    expect(msg).toContain("- PID:          12345");
    expect(msg).toContain("- Dir:          /path/to/project");

    // Platform-aware kill instructions.
    if (process.platform === "win32") {
      expect(msg).toContain("taskkill /PID 12345 /F");
    } else {
      expect(msg).toContain("kill 12345");
    }
  });

  it("falls back to a generic message when the lock file is corrupt", () => {
    const msg = formatAlreadyRunningError({
      existing: undefined,
      cwd: "/path/to/project",
      lockfilePath: "/path/to/project/.vinext/dev/lock.json",
    });
    expect(msg).toContain("Stale lock file");
    expect(msg).toContain(".vinext/dev/lock.json");
  });
});
