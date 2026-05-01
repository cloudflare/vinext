import { describe, it } from "vite-plus/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Issue #1001: Internal modules must use bare specifier imports for shims
// https://github.com/cloudflare/vinext/issues/1001
describe("shim imports use bare specifiers", () => {
  it("all internal imports from shims use vinext/shims/* not relative paths", async () => {
    const srcDir = path.join(__dirname, "../packages/vinext/src");

    // Recursively get all .ts and .tsx files
    async function getFiles(dir: string, baseDir: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(baseDir, fullPath);

        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          files.push(...(await getFiles(fullPath, baseDir)));
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
          !relativePath.startsWith("shims/") // shim files themselves can use relative
        ) {
          files.push(relativePath);
        }
      }

      return files;
    }

    const allFiles = await getFiles(srcDir, srcDir);
    const violations: string[] = [];

    for (const file of allFiles) {
      const content = await fs.readFile(path.join(srcDir, file), "utf-8");
      // Match imports like: from "../shims/something.js"
      const relativeImportPattern = /from\s+["']\.\.\/shims\/[^"']+["']/g;
      const matches = content.match(relativeImportPattern);
      if (matches) {
        for (const match of matches) {
          violations.push(`${file}: ${match}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Found ${violations.length} relative shim import(s) that should use bare specifiers:\n` +
          violations.join("\n") +
          '\n\nChange from: from "../shims/name.js" to: from "vinext/shims/name"',
      );
    }
  });
});
