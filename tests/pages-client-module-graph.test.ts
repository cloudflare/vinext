import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const SOURCE_ROOT = path.resolve(import.meta.dirname, "../packages/vinext/src");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const EAGER_IMPORT_PATTERN =
  /(?:import|export)\s+(?!type\b)(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

function resolveRelativeImport(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path
    .resolve(SOURCE_ROOT, path.dirname(importer), specifier)
    .replace(/\.js$/, "");
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${unresolved}${extension}`;
    if (fs.existsSync(candidate)) return path.relative(SOURCE_ROOT, candidate);
  }
  return null;
}

function collectEagerImports(entry: string): Set<string> {
  const visited = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = fs.readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const match of source.matchAll(EAGER_IMPORT_PATTERN)) {
      const dependency = resolveRelativeImport(file, match[1]!);
      if (dependency !== null) pending.push(dependency);
    }
  }

  return visited;
}

describe("Pages client module graph", () => {
  it.each(["shims/router.ts", "shims/link.tsx"])(
    "%s does not eagerly load server implementations",
    (entry) => {
      const graph = collectEagerImports(entry);
      expect([...graph].filter((file) => file.startsWith("server/"))).toEqual([]);
      expect([...graph].filter((file) => file.startsWith("plugins/"))).toEqual([]);
      expect(graph.has("config/config-matchers.ts")).toBe(false);
    },
  );
});
