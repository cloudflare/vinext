import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SRC_ROOT = path.resolve(import.meta.dirname, "../packages/vinext/src");

let fixtureDir: string | undefined;
let fixtureLinkDir: string | undefined;

function createFixtureDir(): string {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-lint-rule-fixtures-"));
  fixtureLinkDir = path.join(SRC_ROOT, `__lint_rule_fixtures__-${path.basename(fixtureDir)}`);
  fs.symlinkSync(fixtureDir, fixtureLinkDir, "dir");
  return fixtureDir;
}

function writeFixture(name: string, source: string): string {
  const dir = fixtureDir ?? createFixtureDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf-8");
  return path.join(fixtureLinkDir ?? dir, name);
}

function runLint(files: readonly string[]): { status: number | null; output: string } {
  const result = spawnSync("vp", ["lint", ...files], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

afterEach(() => {
  if (fixtureLinkDir) {
    fs.rmSync(fixtureLinkDir, { force: true });
    fixtureLinkDir = undefined;
  }
  if (!fixtureDir) return;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("prefer-shared-utils oxlint rule", () => {
  it("reports local shared-helper definitions across source and generated templates", () => {
    const functionFile = writeFixture(
      "function-helper.ts",
      `
export function isPromiseLike(value: unknown): boolean {
  return value !== null;
}
`,
    );
    const constFile = writeFixture(
      "const-helper.ts",
      `
export const isPromiseLike = (value: unknown): boolean => value !== null;
`,
    );
    const generatedTemplateFile = writeFixture(
      "generated-template.ts",
      `
export const generatedSource = \`
function isPromiseLike(value) {
  return value !== null;
}
\`;
`,
    );
    const exportConstFile = writeFixture(
      "export-const-helper.ts",
      `
export const compareStrings = (left: string, right: string): number =>
  left.localeCompare(right);
`,
    );
    const semanticAliasFile = writeFixture(
      "semantic-alias-helper.ts",
      `
export const compareAppElementsSlotIds = (left: string, right: string): number =>
  left.localeCompare(right);
`,
    );
    const reExportFile = writeFixture(
      "re-export-helper.ts",
      `
export function findFileWithExts(): boolean {
  return false;
}
`,
    );
    // A helper definition embedded in a template literal that also contains an
    // apostrophe and a block-comment sequence before it. These must not be
    // treated as string/comment openers that mask the subsequent definition.
    const templateApostropheFile = writeFixture(
      "template-apostrophe.ts",
      `
export const generatedSource = \`
This template body documents the user's generated output.
function findFileWithExts(value) {
  return value;
}
\`;
`,
    );

    const result = runLint([
      functionFile,
      constFile,
      generatedTemplateFile,
      exportConstFile,
      semanticAliasFile,
      reExportFile,
      templateApostropheFile,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("function-helper.ts");
    expect(result.output).toContain("const-helper.ts");
    expect(result.output).toContain("generated-template.ts");
    expect(result.output).toContain("export-const-helper.ts");
    expect(result.output).toContain("semantic-alias-helper.ts");
    expect(result.output).toContain("re-export-helper.ts");
    expect(result.output).toContain("template-apostrophe.ts");
    expect(result.output).toContain("Use shared isPromiseLike");
    expect(result.output).toContain("Use shared compareStrings");
    expect(result.output).toContain("Use shared compareAppElementsSlotIds");
    expect(result.output).toContain("Use shared findFileWithExts");
  });

  it("allows canonical modules, comments, and ordinary strings", () => {
    const commentsAndStringsFile = writeFixture(
      "comments-and-strings.ts",
      `
// function isPromiseLike(value: unknown): boolean
/* const isPromiseLike = (value: unknown): boolean => true; */
export const docs = "function isPromiseLike(value) { return true; }";
`,
    );

    const result = runLint([
      path.join(SRC_ROOT, "utils/promise.ts"),
      path.join(SRC_ROOT, "server/app-elements-wire.ts"),
      path.join(SRC_ROOT, "entries/pages-entry-helpers.ts"),
      commentsAndStringsFile,
    ]);

    expect(result.status).toBe(0);
    expect(result.output).not.toContain("prefer-shared-utils");
  });
});
