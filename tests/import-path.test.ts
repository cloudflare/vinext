import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { importModule, toImportSpecifier } from "../packages/vinext/src/utils/import-path.js";

describe("import path helpers", () => {
  it("leaves bare module specifiers unchanged", () => {
    expect(toImportSpecifier("vite")).toBe("vite");
  });

  it("converts absolute paths to file URLs", () => {
    const absolutePath = path.join(process.cwd(), "fixtures", "entry.mjs");
    expect(toImportSpecifier(absolutePath)).toBe(pathToFileURL(absolutePath).href);
  });

  it("converts Windows drive-letter paths to file URLs", () => {
    expect(toImportSpecifier("C:\\repo\\app\\entry.mjs")).toBe(
      "file:///C:/repo/app/entry.mjs",
    );
  });

  it("imports modules from absolute paths", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "vinext-import-path-"));
    const modulePath = path.join(tmpDir, "entry.mjs");
    await writeFile(modulePath, 'export const value = 42; export default "ok";\n');

    try {
      const mod = await importModule<{ default: string; value: number }>(modulePath);
      expect(mod.default).toBe("ok");
      expect(mod.value).toBe(42);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
