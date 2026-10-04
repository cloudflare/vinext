import { describe, it, expect, beforeEach, afterEach } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareRetainedAssets } from "../packages/cloudflare/src/retained-assets.js";

const DAY = 24 * 60 * 60 * 1000;
let tmp: string;
let archiveDir: string;

function writeBuild(name: string, files: Record<string, string>): string {
  const clientDir = path.join(tmp, name);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(clientDir, file)), { recursive: true });
    fs.writeFileSync(path.join(clientDir, file), content);
  }
  return clientDir;
}

function prepare(clientDir: string, now: number, options: { maxFiles?: number } = {}) {
  return prepareRetainedAssets({
    archiveDir,
    clientDir,
    assetsDir: "_next/static",
    retentionMs: 7 * DAY,
    now,
    ...options,
  });
}

function readBuilds() {
  return JSON.parse(fs.readFileSync(path.join(archiveDir, "builds.json"), "utf8")) as Array<{
    id: string;
    retiredAt?: number;
  }>;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-retained-assets-"));
  archiveDir = path.join(tmp, "archive");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("prepareRetainedAssets", () => {
  it("first deploy with an empty archive merges nothing and records the build on commit", () => {
    const a = writeBuild("a", { "_next/static/chunks/a.js": "a", "index.html": "<a>" });

    const result = prepare(a, 0);
    expect(result.merged).toBe(0);
    expect(fs.existsSync(path.join(archiveDir, "builds.json"))).toBe(false);

    result.commit();
    expect(readBuilds()).toEqual([expect.objectContaining({ id: result.buildId })]);
    expect(fs.readFileSync(path.join(archiveDir, "files/_next/static/chunks/a.js"), "utf8")).toBe(
      "a",
    );
  });

  it("next build gets the previous build's static files, never its HTML, and keeps its own files", () => {
    prepare(
      writeBuild("a", {
        "_next/static/chunks/a.js": "a",
        "_next/static/shared.css": "s",
        "index.html": "<a>",
      }),
      0,
    ).commit();
    const b = writeBuild("b", {
      "_next/static/chunks/b.js": "b",
      "_next/static/shared.css": "s",
      "index.html": "<b>",
    });

    const result = prepare(b, DAY);

    expect(result.merged).toBe(1);
    expect(fs.readFileSync(path.join(b, "_next/static/chunks/a.js"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(b, "index.html"), "utf8")).toBe("<b>");
  });

  it("previous build is retired when the next deploy commits, not when it is prepared", () => {
    const first = prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0);
    first.commit();
    const second = prepare(writeBuild("b", { "_next/static/b.js": "b" }), 3 * DAY);

    expect(readBuilds().find((build) => build.id === first.buildId)?.retiredAt).toBeUndefined();
    second.commit();
    expect(readBuilds().find((build) => build.id === first.buildId)?.retiredAt).toBe(3 * DAY);
  });

  it("replaced build is retired at commit time, not when the deploy started", () => {
    const first = prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0);
    first.commit();
    const second = prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY);

    second.commit(DAY + 3_600_000);

    expect(readBuilds().find((build) => build.id === first.buildId)?.retiredAt).toBe(
      DAY + 3_600_000,
    );
  });

  it("build retired longer than the retention window is not merged and its files are pruned", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY).commit();
    const c = writeBuild("c", { "_next/static/c.js": "c" });

    const result = prepare(c, 9 * DAY);
    expect(fs.existsSync(path.join(c, "_next/static/a.js"))).toBe(false);
    expect(fs.existsSync(path.join(c, "_next/static/b.js"))).toBe(true);
    result.commit();

    expect(fs.existsSync(path.join(archiveDir, "files/_next/static/a.js"))).toBe(false);
    expect(fs.existsSync(path.join(archiveDir, "files/_next/static/b.js"))).toBe(true);
  });

  it("build that was never replaced does not expire however old it is", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    // A deploy that failed after prepare() never commits, so `a` is still unretired.
    prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY);
    const c = writeBuild("c", { "_next/static/c.js": "c" });

    prepare(c, 30 * DAY);

    expect(fs.existsSync(path.join(c, "_next/static/a.js"))).toBe(true);
  });

  it("same build deployed again still merges older files", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY).commit();
    const again = writeBuild("b-again", { "_next/static/b.js": "b" });

    const result = prepare(again, 2 * DAY);

    expect(result.merged).toBe(1);
    expect(fs.existsSync(path.join(again, "_next/static/a.js"))).toBe(true);
  });

  it("build deployed again after being replaced starts unretired, so it does not expire while serving", () => {
    const a = prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0);
    a.commit();
    prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY).commit();
    prepare(writeBuild("a-again", { "_next/static/a.js": "a" }), 2 * DAY).commit();
    const c = writeBuild("c", { "_next/static/c.js": "c" });

    prepare(c, 20 * DAY);

    expect(readBuilds().find((build) => build.id === a.buildId)?.retiredAt).toBeUndefined();
    expect(fs.existsSync(path.join(c, "_next/static/a.js"))).toBe(true);
  });

  it("preparing the same output twice (--skip-build, retried upload) does not count merged files as this build's", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const b = writeBuild("b", { "_next/static/b.js": "b" });
    const first = prepare(b, DAY);

    const second = prepare(b, DAY);
    second.commit();

    expect(second.buildId).toBe(first.buildId);
    expect(readBuilds().find((build) => build.id === second.buildId)).toMatchObject({
      files: ["_next/static/b.js"],
    });
  });

  it("fresh build into the same directory with the same file names is not mistaken for reused output", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const out = writeBuild("b", { "_next/static/b.js": "b" });
    prepare(out, DAY).commit();
    // A clean rebuild that happens to contain a.js again (e.g. rebuilding an older commit).
    fs.rmSync(out, { recursive: true });
    writeBuild("b", { "_next/static/b.js": "b", "_next/static/a.js": "a" });
    const later = new Date(Date.now() + 60_000);
    for (const file of ["_next/static/b.js", "_next/static/a.js"]) {
      fs.utimesSync(path.join(out, file), later, later);
    }

    prepare(out, 10 * DAY).commit();

    expect(fs.existsSync(path.join(out, "_next/static/a.js"))).toBe(true);
    expect(readBuilds().at(-1)).toMatchObject({
      files: ["_next/static/a.js", "_next/static/b.js"],
    });
  });

  it("reprepared output drops merged files whose build has since expired", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const b = writeBuild("b", { "_next/static/b.js": "b" });
    prepare(b, DAY).commit();

    const again = prepare(b, 10 * DAY);

    expect(fs.existsSync(path.join(b, "_next/static/a.js"))).toBe(false);
    expect(again.merged).toBe(0);
  });

  it("archived file that is a symbolic link is rejected instead of read", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const outside = path.join(tmp, "secret.txt");
    fs.writeFileSync(outside, "secret");
    fs.rmSync(path.join(archiveDir, "files/_next/static/a.js"));
    fs.symlinkSync(outside, path.join(archiveDir, "files/_next/static/a.js"));
    const b = writeBuild("b", { "_next/static/b.js": "b" });

    expect(() => prepare(b, DAY)).toThrow(/symbolic link/);
    expect(fs.existsSync(path.join(b, "_next/static/a.js"))).toBe(false);
  });

  it("archive directory that is a symbolic link is not written through on commit", () => {
    const outside = path.join(tmp, "elsewhere");
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(archiveDir, "files"), { recursive: true });
    fs.symlinkSync(outside, path.join(archiveDir, "files/_next"));
    const a = writeBuild("a", { "_next/static/a.js": "a" });

    expect(() => prepare(a, 0).commit()).toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("archive files directory that is itself a symbolic link is rejected before anything is deleted", () => {
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "unrelated.txt"), "keep");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.symlinkSync(outside, path.join(archiveDir, "files"));

    expect(() => prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0)).toThrow(
      /symbolic link/,
    );
    expect(fs.readFileSync(path.join(outside, "unrelated.txt"), "utf8")).toBe("keep");
  });

  it("dangling symbolic link at an archive destination is not written through", () => {
    const outside = path.join(tmp, "outside.js");
    fs.mkdirSync(path.join(archiveDir, "files/_next/static"), { recursive: true });
    fs.symlinkSync(outside, path.join(archiveDir, "files/_next/static/a.js"));
    const a = writeBuild("a", { "_next/static/a.js": "a" });

    expect(() => prepare(a, 0).commit()).toThrow(/symbolic link/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("hitting the file limit on a rerun deletes nothing from the output", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const b = writeBuild("b", { "_next/static/b.js": "b" });
    prepare(b, DAY).commit();

    expect(() => prepare(b, 10 * DAY, { maxFiles: 0 })).toThrow(/over the limit/);
    expect(fs.existsSync(path.join(b, "_next/static/a.js"))).toBe(true);
  });

  it("archive entry with a backslash is rejected (Windows traversal)", () => {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "builds.json"),
      JSON.stringify([{ id: "x", files: ["_next/static/..\\\\..\\\\_redirects"], createdAt: 0 }]),
    );

    expect(() => prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY)).toThrow(
      /outside the assets directory/,
    );
  });

  it("changing the assets directory keeps earlier builds under their own directory", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    const b = writeBuild("b", { "cdn/_next/static/b.js": "b" });

    const result = prepareRetainedAssets({
      archiveDir,
      clientDir: b,
      assetsDir: "cdn/_next/static",
      retentionMs: 7 * DAY,
      now: DAY,
    });

    expect(result.merged).toBe(1);
    expect(fs.existsSync(path.join(b, "_next/static/a.js"))).toBe(true);
  });

  it("archive build claiming an assets directory other than _next/static is rejected", () => {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "builds.json"),
      JSON.stringify([{ id: "x", assetsDir: "admin", files: ["admin/index.html"], createdAt: 0 }]),
    );

    expect(() => prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY)).toThrow(
      /invalid assets directory/,
    );
  });

  it("builds.json that is a symbolic link is not overwritten", () => {
    const target = path.join(tmp, "target.json");
    fs.writeFileSync(target, "keep");
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.symlinkSync(target, path.join(archiveDir, "builds.json"));

    expect(() => prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit()).toThrow(
      /symbolic link/,
    );
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it("forged prepared.json cannot make the deploy delete files the archive never held", () => {
    const b = writeBuild("b", { "_next/static/b.js": "b", "_next/static/own.js": "own" });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "prepared.json"),
      JSON.stringify({
        clientDir: path.resolve(b),
        buildId: "x",
        files: ["_next/static/b.js"],
        merged: ["_next/static/own.js"],
      }),
    );

    prepare(b, DAY);

    expect(fs.readFileSync(path.join(b, "_next/static/own.js"), "utf8")).toBe("own");
  });

  it("archive entry outside the assets directory is rejected instead of written", () => {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, "builds.json"),
      JSON.stringify([{ id: "x", files: ["../outside.js"], createdAt: 0 }]),
    );

    expect(() => prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY)).toThrow(
      /outside the assets directory/,
    );
    expect(fs.existsSync(path.join(tmp, "outside.js"))).toBe(false);
  });

  it("same path with different bytes throws before anything is written", () => {
    prepare(writeBuild("a", { "_next/static/x.js": "one" }), 0).commit();
    const b = writeBuild("b", { "_next/static/x.js": "two" });

    expect(() => prepare(b, DAY)).toThrow(/_next\/static\/x\.js/);
    expect(fs.readFileSync(path.join(archiveDir, "files/_next/static/x.js"), "utf8")).toBe("one");
  });

  it("archived file that has gone missing throws instead of deploying without it", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a" }), 0).commit();
    fs.rmSync(path.join(archiveDir, "files/_next/static/a.js"));

    expect(() => prepare(writeBuild("b", { "_next/static/b.js": "b" }), DAY)).toThrow(/a\.js/);
  });

  it("merged output over the asset file limit throws with the count", () => {
    prepare(writeBuild("a", { "_next/static/a.js": "a", "_next/static/a2.js": "a" }), 0).commit();
    const b = writeBuild("b", { "_next/static/b.js": "b", "index.html": "<b>" });

    expect(() => prepare(b, DAY, { maxFiles: 3 })).toThrow(/4 .*3/);
  });
});
