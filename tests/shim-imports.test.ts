/**
 * Regression test for #1001:
 * Internal source files must NOT use relative imports for their own shims.
 * Relative imports (e.g. `from "../shims/X.js"`) don't populate
 * @vitejs/plugin-rsc's `packageSources` map, causing the RSC plugin to
 * take a broken fallback code path that generates absolute filesystem paths
 * failing against the package's `exports` field in standard Vite.
 *
 * Rule: source files in src/ (outside src/shims/) import shims via the
 * package's bare specifier: `from "vinext/shims/X"`.
 */
import path from "node:path";
import fs from "node:fs";
import { describe, it, expect } from "vite-plus/test";

const SRC_DIR = path.resolve(import.meta.dirname, "../packages/vinext/src");
const SHIMS_DIR = path.join(SRC_DIR, "shims");

function collectRelativeShimImports(): { file: string; line: number; text: string }[] {
  const violations: { file: string; line: number; text: string }[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip the shims directory itself (imports between shims are fine)
        if (fullPath === SHIMS_DIR) continue;
        walk(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match relative imports of shims: from "../shims/X" or from "../../shims/X"
          if (
            /from\s+["'](\.\.\/)+shims\/[^"']+["']/.test(line) ||
            /require\s*\(\s*["'](\.\.\/)+shims\/[^"']+["']\s*\)/.test(line)
          ) {
            violations.push({
              file: path.relative(SRC_DIR, fullPath),
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }
  }

  walk(SRC_DIR);
  return violations;
}

describe("shim import hygiene (#1001)", () => {
  it("does not use relative imports for shims", () => {
    const violations = collectRelativeShimImports();
    if (violations.length > 0) {
      const details = violations.map((v) => `  ${v.file}:${v.line} → ${v.text}`).join("\n");
      expect.fail(
        `Found ${violations.length} relative shim import(s). ` +
          `Replace with bare specifier "vinext/shims/<name>":\n${details}`,
      );
    }
    expect(violations).toHaveLength(0);
  });
});
