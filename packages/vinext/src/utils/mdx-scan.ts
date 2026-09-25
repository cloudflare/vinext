import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "pathslash";

/** Module-level cache for hasMdxFiles — avoids re-scanning per Vite environment. */
export const mdxScanCache = new Map<string, boolean>();

/**
 * Check if the project has .mdx files in app/ or pages/ directories.
 */
export function hasMdxFiles(root: string, appDir: string | null, pagesDir: string | null): boolean {
  const cacheKey = `${root}\0${appDir ?? ""}\0${pagesDir ?? ""}`;
  if (mdxScanCache.has(cacheKey)) return mdxScanCache.get(cacheKey)!;
  const dirs = [appDir, pagesDir].filter(Boolean) as string[];
  for (const dir of dirs) {
    if (fs.existsSync(dir) && scanDirForMdx(dir)) {
      mdxScanCache.set(cacheKey, true);
      return true;
    }
  }
  mdxScanCache.set(cacheKey, false);
  return false;
}

function scanDirForMdx(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (scanDirForMdx(full)) return true;
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".mdx")) {
        return true;
      }
    }
  } catch {
    // ignore unreadable dirs
  }
  return false;
}

type MdxProcessorModule = {
  createProcessor(): {
    parse(source: string): { children: { type: string; value?: unknown }[] };
  };
};

/**
 * Load a reader that keeps only the ESM of an MDX module, so the JavaScript
 * export helpers can read it. It takes the ESM nodes from the MDX parser that
 * `@mdx-js/rollup` compiles with, resolved beside the plugin vinext
 * auto-injects or one the app installs, or from the app itself. Returns null
 * when that parser isn't installed.
 */
export async function loadMdxEsmReader(root: string): Promise<((source: string) => string) | null> {
  const fromVinext = createRequire(import.meta.url);
  // An app that registers its own MDX plugin builds with the parser it installs.
  const fromRoot = createRequire(path.join(root, "package.json"));
  const candidates = [
    () => createRequire(fromVinext.resolve("@mdx-js/rollup")).resolve("@mdx-js/mdx"),
    () => createRequire(fromRoot.resolve("@mdx-js/rollup")).resolve("@mdx-js/mdx"),
    () => fromRoot.resolve("@mdx-js/mdx"),
  ];
  let mdx: MdxProcessorModule | null = null;
  for (const resolveEntry of candidates) {
    try {
      mdx = (await import(pathToFileURL(resolveEntry()).href)) as MdxProcessorModule;
      break;
    } catch {
      // Try the next place the parser can be installed.
    }
  }
  if (!mdx) return null;
  const processor = mdx.createProcessor();
  return (source) =>
    processor
      .parse(source)
      .children.flatMap((node) =>
        node.type === "mdxjsEsm" && typeof node.value === "string" ? [node.value] : [],
      )
      .join("\n\n");
}
