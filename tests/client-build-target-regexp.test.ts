/**
 * Client chunks must load in every browser an app's `build.target` names.
 *
 * The bundler cannot lower a RegExp lookbehind for a target without it (Safari
 * below 16.4). It turns the literal into a top-level `RegExp(...)` call, which
 * throws a SyntaxError on load in that browser and takes the whole chunk down.
 * vinext's own modules that reach the client therefore use no lookbehind.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { PAGES_FIXTURE_DIR, testCacheDir } from "./helpers.js";

describe("client build for a target without RegExp lookbehind", () => {
  it("emits no lookbehind into Pages Router client chunks", async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-client-target-regexp-"));
    try {
      await build({
        root: PAGES_FIXTURE_DIR,
        cacheDir: testCacheDir(PAGES_FIXTURE_DIR),
        configFile: false,
        plugins: [vinext({ disableAppRouter: true })],
        logLevel: "silent",
        build: {
          outDir,
          target: ["chrome111", "edge111", "firefox114", "safari15"],
          rolldownOptions: { input: "virtual:vinext-client-entry" },
        },
      });

      const lookbehinds: string[] = [];
      for (const entry of await fs.readdir(outDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
        const code = await fs.readFile(path.join(entry.parentPath, entry.name), "utf8");
        for (const match of code.matchAll(/.{0,40}\(\?<[=!].{0,40}/g)) {
          lookbehinds.push(`${entry.name}: ${match[0]}`);
        }
      }
      expect(lookbehinds).toEqual([]);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }, 120_000);
});
