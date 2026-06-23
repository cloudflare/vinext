import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { loadTsconfigPathAliasesForRoot } from "../packages/vinext/src/config/tsconfig-paths.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vinext-tsconfig-paths-test-"));
}

describe("loadTsconfigPathAliasesForRoot", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns absolute alias paths for wildcard mapping without baseUrl", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
          },
        },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "src"));
  });

  it("supports baseUrl with relative path values", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: {
            "@/*": ["src/*"],
          },
        },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "src"));
  });

  it("follows 'extends' for inherited paths", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./lib/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "lib"));
  });

  it("child paths override extended paths", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./lib/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: "./tsconfig.base.json",
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "src"));
  });

  // Ported from Next.js: packages/next/src/build/next-config-ts/transpile-config.ts (array extends)
  it("follows array-form 'extends' for inherited paths", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./lib/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ extends: ["./tsconfig.base.json"] }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "lib"));
  });

  // Ported from Next.js: packages/next/src/build/next-config-ts/transpile-config.ts (array extends)
  it("array-form 'extends': later entries override earlier ones", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.first.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./first/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.second.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./second/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({ extends: ["./tsconfig.first.json", "./tsconfig.second.json"] }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "second"));
  });

  it("child paths override array-form extended paths", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./lib/*"] } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        extends: ["./tsconfig.base.json"],
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "src"));
  });

  it("supports non-wildcard exact alias", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@app": ["./src/app.ts"],
          },
        },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@app"]).toBe(path.join(tmpDir, "src", "app.ts"));
  });

  it("returns empty object when tsconfig.json is missing", () => {
    tmpDir = makeTempDir();
    expect(loadTsconfigPathAliasesForRoot(tmpDir)).toEqual({});
  });

  it("falls back to jsconfig.json when tsconfig.json is absent", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "jsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: { "@/*": ["./src/*"] },
        },
      }),
    );

    const aliases = loadTsconfigPathAliasesForRoot(tmpDir);
    expect(aliases["@"]).toBe(path.join(tmpDir, "src"));
  });

  it("ignores malformed wildcard patterns", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(
      path.join(tmpDir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          // Invalid: wildcard not at end
          paths: { "@*x/*": ["./src/*"] },
        },
      }),
    );
    expect(loadTsconfigPathAliasesForRoot(tmpDir)).toEqual({});
  });

  it("returns empty object on unparseable tsconfig.json", () => {
    tmpDir = makeTempDir();
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "not valid json{{{");
    expect(loadTsconfigPathAliasesForRoot(tmpDir)).toEqual({});
  });
});
