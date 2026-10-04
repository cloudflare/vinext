/**
 * Keep the hashed client assets of recent builds in each new upload, so a tab
 * that was opened before a deploy can still import its lazy chunks.
 *
 * JS chunk URLs carry no deployment id (a query would change module identity
 * under native ESM), so once a new version replaces the old one, an old tab's
 * dynamic import of a chunk the new build does not contain gets a 404. Copying
 * recent builds' files under the assets directory into the new upload keeps
 * those URLs alive. Only files under each build's assets directory are
 * retained; HTML and other top-level files always come from the current build.
 * A path that holds different bytes in two builds (for example
 * `<buildId>/_buildManifest.js` with a fixed `generateBuildId`) stops the
 * deploy instead of picking one.
 *
 * The archive is a directory the caller keeps between deploys:
 *   files/<path>     every retained file, at its path under the client output
 *   builds.json      [{ id, assetsDir, files, createdAt, retiredAt? }]
 *   prepared.json    the last prepared output, so preparing the same output
 *                    again (--skip-build, a retried upload) does not count the
 *                    files merged into it as that build's own
 *
 * The archive may be restored from outside (a CI cache), so every path read
 * from it must be a plain relative path under its build's assets directory,
 * and nothing is read, written or deleted through a symbolic link inside it.
 *
 * Expiry rules:
 * - A build is retired when a deploy of a different build commits. Retiring
 *   happens in `commit()`, after the deploy succeeded, never in `prepare`.
 *   Deploying a retired build again makes it unretired.
 * - A build that was never retired never expires: an unknown state is not
 *   treated as "no longer served".
 * - A retired build is merged until `retentionMs` has passed since retiring.
 *
 * Out of scope: rolling back to an existing version (its upload does not
 * contain later builds' files) and recovering a tab whose import already failed.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type RetainedBuild = {
  id: string;
  /** Assets directory of this build, relative to the client output. */
  assetsDir?: string;
  files: string[];
  createdAt: number;
  retiredAt?: number;
};

export type PrepareRetainedAssetsOptions = {
  /** Directory kept between deploys (for example restored from a CI cache). */
  archiveDir: string;
  /** Client output that is about to be uploaded as the Worker's static assets. */
  clientDir: string;
  /** Hashed assets directory relative to `clientDir`, e.g. `_next/static`. */
  assetsDir: string;
  retentionMs: number;
  now?: number;
  /** Upper bound on files in the merged upload (Workers static asset limit). */
  maxFiles?: number;
};

export type PreparedRetainedAssets = {
  buildId: string;
  /** Number of files copied from earlier builds into `clientDir`. */
  merged: number;
  /**
   * Record this build and retire the others. Call only after the deploy
   * succeeded; the replaced builds are retired at `at` (default: now).
   */
  commit: (at?: number) => void;
};

/** Days a replaced build stays in later uploads unless --retain-assets-days says otherwise. */
export const DEFAULT_RETAIN_ASSETS_DAYS = 7;

const BUILDS_FILE = "builds.json";
const PREPARED_FILE = "prepared.json";
const FILES_DIR = "files";

type PreparedOutput = {
  clientDir: string;
  buildId: string;
  files: string[];
  merged: string[];
  /** Modification times of `files`: a rebuild rewrites them, a rerun does not. */
  fingerprint: string;
};

/** A forward-slash relative path with no `..`, `.`, backslash or absolute form. */
function isPlainRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function assertUnderAssetsDir(file: unknown, assetsDir: string): asserts file is string {
  if (!isPlainRelativePath(file) || !file.startsWith(`${assetsDir}/`)) {
    throw new Error(
      `[vinext] Retained asset ${JSON.stringify(file)} in the archive is outside the assets directory ${assetsDir}.`,
    );
  }
}

/**
 * Path inside the archive for `relative`, after checking that no existing
 * component below the archive directory is a symbolic link (dangling or not).
 */
function archivePath(archiveDir: string, relative: string): string {
  let current = archiveDir;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch {
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`[vinext] ${current} in the retained-assets archive is a symbolic link.`);
    }
  }
  return path.join(archiveDir, relative);
}

function fingerprintOutput(clientDir: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const full = path.join(clientDir, file);
    hash.update(`${file}:${fs.existsSync(full) ? fs.statSync(full).mtimeMs : "missing"}\n`);
  }
  return hash.digest("hex");
}

/** Regular files only: symbolic links are neither followed nor listed. */
function listFiles(root: string, relative: string): string[] {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = relative === "." ? entry.name : path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return listFiles(root, child);
    return entry.isFile() ? [child] : [];
  });
}

function countFiles(root: string): number {
  return fs.readdirSync(root, { withFileTypes: true }).reduce((count, entry) => {
    if (entry.isDirectory()) return count + countFiles(path.join(root, entry.name));
    return entry.isFile() ? count + 1 : count;
  }, 0);
}

function readJson(file: string): unknown {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

function readBuilds(archiveDir: string, currentAssetsDir: string): RetainedBuild[] {
  const parsed = readJson(archivePath(archiveDir, BUILDS_FILE));
  if (parsed === undefined) return [];
  const isBuild = (value: unknown): value is RetainedBuild =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as RetainedBuild).id === "string" &&
    Array.isArray((value as RetainedBuild).files) &&
    typeof (value as RetainedBuild).createdAt === "number";
  if (!Array.isArray(parsed) || !parsed.every(isBuild)) {
    throw new Error(
      `[vinext] ${BUILDS_FILE} in the retained-assets archive is not a list of builds.`,
    );
  }
  for (const build of parsed) {
    const assetsDir = build.assetsDir ?? currentAssetsDir;
    // Only a hashed assets directory may be restored from the archive, never an
    // arbitrary path that would put pages or routing files into the upload.
    if (
      !isPlainRelativePath(assetsDir) ||
      (assetsDir !== "_next/static" && !assetsDir.endsWith("/_next/static"))
    ) {
      throw new Error(`[vinext] Build ${build.id} has an invalid assets directory.`);
    }
    for (const file of build.files) assertUnderAssetsDir(file, assetsDir);
  }
  return parsed;
}

function readPreparedOutput(archiveDir: string): PreparedOutput | null {
  const parsed = readJson(archivePath(archiveDir, PREPARED_FILE)) as PreparedOutput | undefined;
  if (!parsed) return null;
  const paths = [...(parsed.files ?? []), ...(parsed.merged ?? [])];
  if (!paths.every(isPlainRelativePath)) {
    throw new Error(
      `[vinext] ${PREPARED_FILE} in the retained-assets archive lists an invalid path.`,
    );
  }
  return parsed;
}

function sameBytes(a: string, b: string): boolean {
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** Copy without overwriting; the same path must never hold different bytes. */
function copyImmutable(source: string, target: string): void {
  if (fs.existsSync(target)) {
    if (!sameBytes(source, target)) {
      throw new Error(
        `[vinext] Retained asset ${target} differs from ${source}. A path under the assets directory must not change content between builds.`,
      );
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((item) => set.has(item));
}

function isLive(build: RetainedBuild, now: number, retentionMs: number): boolean {
  return build.retiredAt === undefined || now - build.retiredAt < retentionMs;
}

export function prepareRetainedAssets(
  options: PrepareRetainedAssetsOptions,
): PreparedRetainedAssets {
  const { archiveDir, clientDir, assetsDir, retentionMs } = options;
  const now = options.now ?? Date.now();
  const archived = (file: string) => archivePath(archiveDir, `${FILES_DIR}/${file}`);
  const outputDir = path.resolve(clientDir);
  const scanned = listFiles(clientDir, assetsDir);

  // The same output prepared again still holds the files merged into it last time.
  const previous = readPreparedOutput(archiveDir);
  const reused =
    previous?.clientDir === outputDir &&
    sameSet(scanned, [...previous.files, ...previous.merged]) &&
    previous.fingerprint === fingerprintOutput(clientDir, previous.files)
      ? previous
      : null;
  const currentFiles = (reused ? reused.files : scanned).sort();
  const buildId = createHash("sha256").update(currentFiles.join("\n")).digest("hex").slice(0, 16);
  const builds = readBuilds(archiveDir, assetsDir);
  const retained = [
    ...new Set(
      builds
        .filter((build) => build.id !== buildId && isLive(build, now, retentionMs))
        .flatMap((build) => build.files),
    ),
  ];

  // Check everything before writing anything, so a failure leaves both trees untouched.
  for (const file of retained) {
    const source = archived(file);
    if (!fs.existsSync(source)) {
      throw new Error(
        `[vinext] Retained asset ${file} is listed in ${BUILDS_FILE} but missing from the archive. Restore the archive or remove it to start over.`,
      );
    }
    const target = path.join(clientDir, file);
    if (fs.existsSync(target) && !sameBytes(source, target)) {
      throw new Error(
        `[vinext] Retained asset ${file} differs from the file with the same path in this build.`,
      );
    }
  }
  for (const file of currentFiles) {
    const source = archived(file);
    if (fs.existsSync(source) && !sameBytes(source, path.join(clientDir, file))) {
      throw new Error(
        `[vinext] ${file} in this build differs from the archived file with the same path.`,
      );
    }
  }

  // Files merged into this output earlier whose build has since expired must not
  // be uploaded again. Only delete what provably came from the archive.
  const retainedSet = new Set(retained);
  const expired = (reused?.merged ?? []).filter((file) => {
    if (retainedSet.has(file)) return false;
    const source = archived(file);
    const output = path.join(clientDir, file);
    return fs.existsSync(source) && fs.existsSync(output) && sameBytes(source, output);
  });
  const toMerge = retained.filter((file) => !fs.existsSync(path.join(clientDir, file)));
  if (options.maxFiles !== undefined) {
    const total = countFiles(clientDir) - expired.length + toMerge.length;
    if (total > options.maxFiles) {
      throw new Error(
        `[vinext] Retaining earlier builds' assets would upload ${total} files, over the limit of ${options.maxFiles}. Shorten the retention window.`,
      );
    }
  }

  for (const file of expired) fs.rmSync(path.join(clientDir, file));
  for (const file of toMerge) copyImmutable(archived(file), path.join(clientDir, file));
  fs.mkdirSync(archiveDir, { recursive: true });
  const prepared: PreparedOutput = {
    clientDir: outputDir,
    buildId,
    files: currentFiles,
    merged: [
      ...new Set([...(reused?.merged ?? []).filter((file) => retainedSet.has(file)), ...toMerge]),
    ],
    fingerprint: fingerprintOutput(clientDir, currentFiles),
  };
  fs.writeFileSync(archivePath(archiveDir, PREPARED_FILE), `${JSON.stringify(prepared)}\n`);

  return {
    buildId,
    merged: toMerge.length,
    commit(at = options.now ?? Date.now()) {
      for (const file of currentFiles) {
        copyImmutable(path.join(clientDir, file), archived(file));
      }
      const next = builds
        .map((build): RetainedBuild => {
          if (build.id !== buildId) {
            return build.retiredAt === undefined ? { ...build, retiredAt: at } : build;
          }
          return {
            id: build.id,
            assetsDir: build.assetsDir,
            files: build.files,
            createdAt: build.createdAt,
          };
        })
        .filter((build) => build.id === buildId || isLive(build, at, retentionMs));
      if (!next.some((build) => build.id === buildId)) {
        next.push({ id: buildId, assetsDir, files: currentFiles, createdAt: at });
      }
      const kept = new Set(next.flatMap((build) => build.files));
      const filesRoot = archivePath(archiveDir, FILES_DIR);
      for (const file of listFiles(filesRoot, ".")) {
        if (!kept.has(file)) fs.rmSync(archived(file));
      }
      fs.writeFileSync(archivePath(archiveDir, BUILDS_FILE), `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}
