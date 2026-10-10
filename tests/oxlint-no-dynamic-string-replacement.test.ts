import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// The rule is scoped to runtime directories; build/ is outside that scope.
const SERVER_ROOT = path.resolve(import.meta.dirname, "../packages/vinext/src/server");
const BUILD_ROOT = path.resolve(import.meta.dirname, "../packages/vinext/src/build");

let fixtureDir: string | undefined;
const fixtureLinkDirs: string[] = [];

function writeFixture(name: string, source: string, root = SERVER_ROOT): string {
  fixtureDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "vinext-lint-rule-fixtures-"));
  const linkDir = path.join(root, `__lint_rule_fixtures__-${path.basename(fixtureDir)}`);
  if (!fixtureLinkDirs.includes(linkDir)) {
    fs.symlinkSync(fixtureDir, linkDir, "dir");
    fixtureLinkDirs.push(linkDir);
  }
  fs.writeFileSync(path.join(fixtureDir, name), source, "utf-8");
  return path.join(linkDir, name);
}

function runLint(file: string): { status: number | null; output: string } {
  const result = spawnSync("vp", ["lint", file], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

afterEach(() => {
  for (const linkDir of fixtureLinkDirs.splice(0)) {
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
  if (!fixtureDir) return;
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

describe("no-dynamic-string-replacement oxlint rule", () => {
  it("reports dynamic string replacements and allows static strings and functions", () => {
    const file = writeFixture(
      "replacements.ts",
      `
const PLACEHOLDER = "<!-- slot -->";

function escapeChar(char: string): string {
  return char;
}

const encode = (value: string): string => value;
let reassignable = (value: string): string => value;

export function splice(html: string, data: string, mapTag: (tag: string) => string): string[] {
  const replacement = \`<p>\${data}</p>\`;
  const router = { replace: (_url: string, _as: string, _options: object) => "" };
  return [
    html.replace(PLACEHOLDER, \`<p>\${data}</p>\`),
    html.replaceAll(PLACEHOLDER, replacement),
    html.replace(PLACEHOLDER, data),
    html["replace"](PLACEHOLDER, data),
    html.replace(PLACEHOLDER, reassignable),
    html.replace(PLACEHOLDER, "<p></p>"),
    html.replace(PLACEHOLDER, \`<p></p>\`),
    html.replace(PLACEHOLDER, () => \`<p>\${data}</p>\`),
    html.replace(/[<>]/g, escapeChar),
    html.replace(/[<>]/g, encode),
    html.replace(/<a\\b[^>]*>/g, mapTag),
    html.replace(/[?#]/g, encodeURIComponent),
    router.replace(html, data, {}),
  ];
}
`,
    );

    const result = runLint(file);

    expect(result.status).not.toBe(0);
    const reportedLines = [
      ...result.output.matchAll(/replacements\.ts:(\d+):\d+: error vinext-security/g),
    ].map((match) => Number(match[1]));
    expect(reportedLines).toEqual([15, 16, 17, 18, 19]);
  });

  it("leaves files outside the runtime directories alone", () => {
    const file = writeFixture(
      "outside.ts",
      `export const splice = (html: string, data: string): string => html.replace("<!-- slot -->", data);\n`,
      BUILD_ROOT,
    );

    expect(runLint(file)).toMatchObject({ status: 0 });
  });
});
