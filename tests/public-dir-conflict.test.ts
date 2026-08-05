import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { assertNoPublicDirAssetConflict } from "../packages/vinext/src/build/public-dir-conflict.js";

// Regression for cloudflare/vinext#2778: Vite copies public files into the
// client output, so public/_next would otherwise collide with vinext's internal
// build-asset namespace and be served as a hashed asset ahead of middleware.
// Next.js rejects the same public/_next namespace during build:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/build/index.ts
describe("assertNoPublicDirAssetConflict", () => {
  const tmpDirs: string[] = [];

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-public-dir-conflict-"));
    tmpDirs.push(dir);
    return dir;
  }

  function writeFile(root: string, relativePath: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "test", "utf-8");
  }

  function assertDefaultProject(root: string): void {
    assertNoPublicDirAssetConflict({
      root,
      publicDir: "public",
      assetsDir: "_next/static",
    });
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a missing public directory", () => {
    const root = makeProject();

    expect(() => assertDefaultProject(root)).not.toThrow();
  });

  it("allows ordinary files in the public directory", () => {
    const root = makeProject();
    writeFile(root, "public/private.txt");

    expect(() => assertDefaultProject(root)).not.toThrow();
  });

  it("rejects an empty public/_next directory", () => {
    const root = makeProject();
    fs.mkdirSync(path.join(root, "public", "_next"), { recursive: true });

    expect(() => assertDefaultProject(root)).toThrow(
      "You can not have a '_next' folder inside of your public folder.",
    );
  });

  it("rejects files under public/_next/static", () => {
    const root = makeProject();
    writeFile(root, "public/_next/static/private.txt");

    expect(() => assertDefaultProject(root)).toThrow(
      "https://nextjs.org/docs/messages/public-next-folder-conflict",
    );
  });

  it("resolves a custom public directory relative to the project root", () => {
    const root = makeProject();
    writeFile(root, "custom-public/_next/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "custom-public",
        assetsDir: "_next/static",
      }),
    ).toThrow("This conflicts with the internal '/_next' route.");
  });

  it("supports an absolute public directory", () => {
    const root = makeProject();
    const publicDir = path.join(root, "custom-public");
    writeFile(publicDir, "_next/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir,
        assetsDir: "_next/static",
      }),
    ).toThrow("You can not have a '_next' folder inside of your public folder.");
  });

  it("skips validation when the public directory is disabled", () => {
    const root = makeProject();
    writeFile(root, "public/_next/static/private.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: null,
        assetsDir: "_next/static",
      }),
    ).not.toThrow();
  });

  it("rejects a public path that collides with a custom assets directory", () => {
    const root = makeProject();
    writeFile(root, "public/cdn/_next/static/private.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "public",
        assetsDir: "cdn/_next/static",
      }),
    ).toThrow(
      "[vinext] The public directory contains a path reserved for build assets: " +
        "cdn/_next/static",
    );
  });

  it("does not inspect an assets directory outside the public directory", () => {
    const root = makeProject();
    writeFile(root, "outside-assets/file.txt");

    expect(() =>
      assertNoPublicDirAssetConflict({
        root,
        publicDir: "public",
        assetsDir: "../outside-assets",
      }),
    ).not.toThrow();
  });
});
