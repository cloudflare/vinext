import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  importServerEntryModule,
  rememberCurrentServerEntryImportMtime,
  resolveServerEntryImportUrl,
} from "../packages/vinext/src/server/prod-server.js";

/**
 * Unit tests for the production server's entry import helper.
 *
 * The helper must satisfy two requirements that used to conflict:
 *
 * 1. The first import of a built entry must use the bare (query-less)
 *    canonical file:// URL, so emitted chunks that import the entry back by
 *    bare specifier or via realpath-derived URLs resolve to the SAME module
 *    instance. The previous unconditional
 *    `?t=<mtime>` query created a second instance of the whole server bundle
 *    and module-level singletons diverged.
 *
 * 2. Re-importing the same path after a rebuild (test suites rebuilding a
 *    fixture to the same output path within one process) must still load the
 *    fresh build, not Node's cached copy — the reason the `?t=` query
 *    existed in the first place.
 *
 * The URL choice is asserted via resolveServerEntryImportUrl: Node's
 * native ESM loader keys its cache on the full URL (query included), so the
 * chosen URL fully determines the cache behavior. (The end-to-end module
 * identity for the bare-URL case is additionally covered here and by the
 * production-server integration test; the rebuild case cannot be asserted
 * end-to-end under the Vitest module runner, which does not replicate
 * Node's query-sensitive ESM cache for externalized files.)
 */
describe("server entry import URL resolution", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-entry-import-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("uses the bare canonical URL for the first import of a path", () => {
    const dir = makeTmpDir();
    const entryPath = path.join(dir, "entry.mjs");
    fs.writeFileSync(entryPath, `export const state = {};\n`);

    const url = resolveServerEntryImportUrl(entryPath);

    expect(url).toBe(pathToFileURL(fs.realpathSync.native(entryPath)).href);
    expect(url).not.toContain("?");
  });

  it("keeps the bare URL for repeated imports of an unchanged build", () => {
    const dir = makeTmpDir();
    const entryPath = path.join(dir, "entry.mjs");
    fs.writeFileSync(entryPath, `export const state = {};\n`);

    const first = resolveServerEntryImportUrl(entryPath);
    const second = resolveServerEntryImportUrl(entryPath);

    expect(second).toBe(first);
    expect(second).not.toContain("?");
  });

  it("resolves symlinked paths to the same canonical bare URL", () => {
    const dir = makeTmpDir();
    const realDir = path.join(dir, "real");
    const linkDir = path.join(dir, "link");
    fs.mkdirSync(realDir);
    fs.symlinkSync(realDir, linkDir, "junction");
    const realEntryPath = path.join(realDir, "entry.mjs");
    fs.writeFileSync(realEntryPath, `export const state = {};\n`);

    const viaLink = resolveServerEntryImportUrl(path.join(linkDir, "entry.mjs"));
    const viaReal = resolveServerEntryImportUrl(realEntryPath);

    expect(viaLink).toBe(viaReal);
    expect(viaLink).not.toContain("?");
  });

  it("cache-busts only when the same path is reimported after a rebuild", () => {
    const dir = makeTmpDir();
    const entryPath = path.join(dir, "entry.mjs");

    fs.writeFileSync(entryPath, `export const state = { marker: "build-1" };\n`);
    const firstBuildUrl = resolveServerEntryImportUrl(entryPath);
    expect(firstBuildUrl).not.toContain("?");

    // Rebuild to the same path with a guaranteed-different mtime.
    fs.writeFileSync(entryPath, `export const state = { marker: "build-2" };\n`);
    const bumped = new Date(Date.now() + 10_000);
    fs.utimesSync(entryPath, bumped, bumped);
    const rebuiltMtime = fs.statSync(entryPath).mtimeMs;

    const secondBuildUrl = resolveServerEntryImportUrl(entryPath);
    expect(secondBuildUrl).toBe(`${firstBuildUrl}?t=${rebuiltMtime}`);

    // Importing again without another rebuild keeps the busted URL stable,
    // so the rebuilt module instance is reused rather than re-evaluated or
    // replaced by the original bare-URL cache entry.
    const thirdImportUrl = resolveServerEntryImportUrl(entryPath);
    expect(thirdImportUrl).toBe(secondBuildUrl);
  });

  it("can keep the bare URL after a same-process global-only entry injection", () => {
    const dir = makeTmpDir();
    const entryPath = path.join(dir, "entry.mjs");

    fs.writeFileSync(entryPath, `export const state = { marker: "build-1" };\n`);
    const firstBuildUrl = resolveServerEntryImportUrl(entryPath);
    expect(firstBuildUrl).not.toContain("?");

    fs.writeFileSync(
      entryPath,
      [
        'globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = [["/blog/:slug",["/blog/post-a"]]];',
        `export const state = { marker: "build-1" };`,
        "",
      ].join("\n"),
    );
    const bumped = new Date(Date.now() + 10_000);
    fs.utimesSync(entryPath, bumped, bumped);

    expect(resolveServerEntryImportUrl(entryPath)).toContain("?t=");
    rememberCurrentServerEntryImportMtime(entryPath);
    expect(resolveServerEntryImportUrl(entryPath)).toBe(firstBuildUrl);
  });

  it("shares the module instance with chunks that import the entry by bare specifier", async () => {
    const dir = makeTmpDir();
    const entryPath = path.join(dir, "entry.mjs");
    const chunkPath = path.join(dir, "chunk.mjs");
    fs.writeFileSync(entryPath, `export const state = { ready: false };\n`);
    fs.writeFileSync(chunkPath, `export { state } from "./entry.mjs";\n`);

    const entry = await importServerEntryModule(entryPath);
    entry.state.ready = true;

    // The chunk resolves "./entry.mjs" bare — exactly like a code-split
    // server chunk importing the entry back. It must observe the same
    // instance the server is using, not a second evaluation.
    const chunk = await import(pathToFileURL(fs.realpathSync.native(chunkPath)).href);
    expect(chunk.state).toBe(entry.state);
    expect(chunk.state.ready).toBe(true);
  });
});
