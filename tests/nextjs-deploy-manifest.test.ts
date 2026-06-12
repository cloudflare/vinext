import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);
const suite = "test/e2e/repeated-forward-slashes-error/repeated-forward-slashes-error.test.ts";

describe("nextjs deploy manifest", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fsp.rm(root, { recursive: true, force: true });
  });

  // The upstream suite waits for a runtime warning in `next.cliOutput`, but
  // NextDeployInstance captures custom deploy logs only once during setup:
  // https://github.com/vercel/next.js/blob/canary/test/lib/next-modes/next-deploy.ts
  it("excludes suites that require live runtime cliOutput from custom deploy adapters", async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-nextjs-deploy-manifest-"));
    const nextjsDir = path.join(root, "next.js");
    const sourcePath = path.join(nextjsDir, "test", "deploy-tests-manifest.json");
    const outputPath = path.join(root, "manifest.json");

    await fsp.mkdir(path.dirname(sourcePath), { recursive: true });
    await fsp.writeFile(
      sourcePath,
      `${JSON.stringify({
        version: 2,
        suites: { [suite]: {} },
        rules: { include: ["test/e2e/**/*.test.{t,j}s{,x}"], exclude: [] },
      })}\n`,
    );

    await execFileAsync(
      process.execPath,
      [path.resolve("scripts/nextjs-deploy-manifest.mjs"), nextjsDir, outputPath, "--match", suite],
      { cwd: path.resolve(".") },
    );

    const manifest = JSON.parse(await fsp.readFile(outputPath, "utf8"));
    expect(manifest.rules.include).toEqual([suite]);
    expect(manifest.rules.exclude).toContain(suite);
  });
});
