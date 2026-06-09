import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_VINEXT_ASSET_IGNORE_PATTERNS,
  ensureAssetsIgnore,
} from "../packages/vinext/src/build/assets-ignore.js";

// Regression: the Cloudflare ASSETS binding serves any uploaded file matching
// the request path BEFORE the Worker runs, so Vite's build/SSR manifests under
// `dist/client/.vite/` would otherwise be publicly fetchable at
// `/.vite/manifest.json`. The Node prod server blocks `/.vite/` explicitly;
// this `.assetsignore` is the Cloudflare-side equivalent.
describe("ensureAssetsIgnore", () => {
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-assetsignore-"));
    tmpDirs.push(dir);
    return dir;
  }

  function readIgnore(dir: string): string {
    return fs.readFileSync(path.join(dir, ".assetsignore"), "utf-8");
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excludes `.vite` by default", () => {
    expect(DEFAULT_VINEXT_ASSET_IGNORE_PATTERNS).toContain(".vite");
  });

  it("creates a `.assetsignore` containing the default patterns", () => {
    const dir = makeDir();
    const changed = ensureAssetsIgnore(dir);
    expect(changed).toBe(true);

    const lines = new Set(
      readIgnore(dir)
        .split("\n")
        .map((l) => l.trim()),
    );
    for (const pattern of DEFAULT_VINEXT_ASSET_IGNORE_PATTERNS) {
      expect(lines.has(pattern)).toBe(true);
    }
  });

  it("creates the assets dir if it does not exist", () => {
    const dir = path.join(makeDir(), "nested", "client");
    ensureAssetsIgnore(dir);
    expect(fs.existsSync(path.join(dir, ".assetsignore"))).toBe(true);
  });

  it("is idempotent — a second call makes no change and does not duplicate entries", () => {
    const dir = makeDir();
    expect(ensureAssetsIgnore(dir)).toBe(true);
    const first = readIgnore(dir);

    expect(ensureAssetsIgnore(dir)).toBe(false);
    expect(readIgnore(dir)).toBe(first);

    const occurrences = first.split("\n").filter((l) => l.trim() === ".vite").length;
    expect(occurrences).toBe(1);
  });

  it("preserves user-authored content and only appends missing patterns", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, ".assetsignore"), "_worker.js\nsecret-stuff/\n");

    const changed = ensureAssetsIgnore(dir);
    expect(changed).toBe(true);

    const content = readIgnore(dir);
    // User entries are kept verbatim...
    expect(content).toContain("_worker.js");
    expect(content).toContain("secret-stuff/");
    // ...and the security pattern is appended.
    expect(content.split("\n").map((l) => l.trim())).toContain(".vite");
  });

  it("does not re-append a pattern the user already listed", () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, ".assetsignore"), ".vite\n");

    expect(ensureAssetsIgnore(dir)).toBe(false);
    const occurrences = readIgnore(dir)
      .split("\n")
      .filter((l) => l.trim() === ".vite").length;
    expect(occurrences).toBe(1);
  });

  it("honors a custom pattern list", () => {
    const dir = makeDir();
    ensureAssetsIgnore(dir, [".vite", "*.map"]);
    const lines = readIgnore(dir)
      .split("\n")
      .map((l) => l.trim());
    expect(lines).toContain(".vite");
    expect(lines).toContain("*.map");
  });
});
