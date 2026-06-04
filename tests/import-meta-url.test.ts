import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rewriteImportMetaUrl } from "../packages/vinext/src/plugins/import-meta-url.js";

describe("vinext:import-meta-url plugin", () => {
  let tmpDir: string;
  let realRoot: string;
  let linkedRoot: string;
  let pagePath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vinext-import-meta-url-"));
    realRoot = path.join(tmpDir, "real-app");
    linkedRoot = path.join(tmpDir, "linked-app");
    pagePath = path.join(realRoot, "pages", "index.tsx");

    await fsp.mkdir(path.dirname(pagePath), { recursive: true });
    await fsp.writeFile(pagePath, `export const url = import.meta.url;\n`);
    await fsp.symlink(realRoot, linkedRoot, "junction");
  });

  afterAll(async () => {
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes client import.meta.url to a Turbopack-style /ROOT source URL", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`"file:///ROOT/pages/index.tsx"`);
  });

  it("preserves the real server source file URL", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "server",
    );

    expect(result?.code).toMatch(/"file:\/\/\/.*\/pages\/index\.tsx"/);
    expect(result?.code).not.toContain("linked-app");
  });

  it("does not rewrite the import.meta.url base argument in new URL asset expressions", () => {
    const result = rewriteImportMetaUrl(
      `const asset = new URL("./font.ttf", import.meta.url);\nconst url = import.meta.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`new URL("./font.ttf", import.meta.url)`);
    expect(result?.code).toContain(`const url = "file:///ROOT/pages/index.tsx"`);
  });

  it("preserves import.meta?.url as the base argument in new URL asset expressions", () => {
    const result = rewriteImportMetaUrl(
      `const asset = new URL("./font.ttf", import.meta?.url);\nconst url = import.meta?.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`new URL("./font.ttf", import.meta?.url)`);
    expect(result?.code).toContain(`const url = "file:///ROOT/pages/index.tsx"`);
  });

  it("rewrites optional chained import.meta.url reads", () => {
    const result = rewriteImportMetaUrl(
      `export const url = import.meta?.url;\n`,
      pagePath,
      linkedRoot,
      "client",
    );

    expect(result?.code).toContain(`"file:///ROOT/pages/index.tsx"`);
  });
});
