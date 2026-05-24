import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanBuildOutput } from "../packages/vinext/src/build/clean-output.js";

let tmpDir: string;

function writeFile(root: string, relativePath: string, content: string): string {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

describe("cleanBuildOutput", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-clean-output-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes stale server modules from the build output by default", () => {
    const staleModule = writeFile(
      tmpDir,
      "dist/server/ssr/_next/static/stale-dead-module.js",
      "export default 1;\n",
    );

    const result = cleanBuildOutput({ root: tmpDir });

    expect(result.cleaned).toBe(true);
    expect(result.outDir).toBe(path.join(tmpDir, "dist"));
    expect(fs.existsSync(staleModule)).toBe(false);
  });

  it("preserves the build output when emptyOutDir is explicitly disabled", () => {
    const staleModule = writeFile(
      tmpDir,
      "dist/server/ssr/_next/static/stale-dead-module.js",
      "export default 1;\n",
    );

    const result = cleanBuildOutput({ root: tmpDir, emptyOutDir: false });

    expect(result.cleaned).toBe(false);
    expect(fs.existsSync(staleModule)).toBe(true);
  });

  it("does not remove an output directory outside the project root by default", () => {
    const externalOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-external-output-"));
    try {
      const staleModule = writeFile(externalOutDir, "stale-dead-module.js", "export default 1;\n");

      const result = cleanBuildOutput({ root: tmpDir, outDir: externalOutDir });

      expect(result.cleaned).toBe(false);
      expect(fs.existsSync(staleModule)).toBe(true);
    } finally {
      fs.rmSync(externalOutDir, { recursive: true, force: true });
    }
  });
});
