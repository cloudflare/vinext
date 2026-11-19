import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vite-plus/test";

// The fixture's Vite config bundles React into the server build, so the
// externals manifest no longer lists it. vinext's own production server still
// imports React (its fallback prerender seeder does), so standalone output must
// ship it regardless, the way Next.js traces next-server's own imports. Covers
// https://github.com/cloudflare/vinext/issues/3486.

const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/standalone-bundled-react");
const DIST_DIR = path.join(FIXTURE_DIR, "dist");
const VINEXT_ROOT = path.resolve(import.meta.dirname, "../packages/vinext");

function readVersion(packageJsonPath: string): string {
  return (JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { version: string }).version;
}

describe("standalone output when the server bundle inlines React", () => {
  beforeAll(() => {
    fs.rmSync(DIST_DIR, { recursive: true, force: true });
    // execFileSync blocks the event loop, so the hook timeout cannot interrupt
    // a hung build. Bound the subprocess itself.
    execFileSync(process.execPath, [CLI_PATH, "build"], {
      cwd: FIXTURE_DIR,
      stdio: "pipe",
      timeout: 150_000,
    });
  }, 180_000);

  it("bundles React instead of leaving it external", () => {
    const externals = JSON.parse(
      fs.readFileSync(path.join(DIST_DIR, "server/vinext-externals.json"), "utf-8"),
    ) as string[];
    expect(externals.filter((specifier) => /^react(?:-dom)?(?:\/|$)/.test(specifier))).toEqual([]);
  });

  it("ships the React that vinext's production server resolves", () => {
    const vinextReact = createRequire(path.join(VINEXT_ROOT, "package.json")).resolve(
      "react/package.json",
    );
    expect(readVersion(path.join(DIST_DIR, "standalone/node_modules/react/package.json"))).toBe(
      readVersion(vinextReact),
    );
  });
});
