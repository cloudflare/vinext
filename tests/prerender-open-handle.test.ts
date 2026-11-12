/**
 * A prerendering build exits even when an application module opens a handle at
 * import time. `next build` does: it only imports application code in static
 * workers, which it ends once the build finishes.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { createIsolatedFixture } from "./helpers.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, "../packages/vinext/dist/cli.js");
const FIXTURE_DIR = path.resolve(import.meta.dirname, "fixtures/app-prerender-open-handle");
const NODE_MODULES_DIR = path.resolve(import.meta.dirname, "fixtures/app-basic/node_modules");

it("exits after prerendering an app whose module keeps a timer open", async () => {
  const root = await createIsolatedFixture(
    FIXTURE_DIR,
    "vinext-prerender-open-handle-",
    undefined,
    NODE_MODULES_DIR,
  );
  fs.writeFileSync(path.join(root, "package.json"), '{"private":true,"type":"module"}');
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, "build"], {
      cwd: root,
      env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1" },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    expect(stdout).toContain("Prerendered 2 routes");
    expect(stdout).toContain("Build complete.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
