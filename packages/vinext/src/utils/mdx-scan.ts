import fs from "node:fs";
import path from "pathslash";
import { parseSync } from "vite";

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

/**
 * Keep only the ESM of an MDX module, so the JavaScript export helpers can
 * read it. MDX takes a block as ESM when an unindented line starts with
 * `import` or `export` outside a code fence, and the block runs until the
 * first blank line at which its JavaScript parses.
 * https://github.com/micromark/micromark-extension-mdxjs-esm
 */
export function extractMdxEsm(source: string): string {
  const blocks: string[] = [];
  let block: string[] | null = null;
  let fence: string | null = null;
  for (const line of source.split(/\r?\n/)) {
    if (block) {
      if (line.trim() === "" && isCompleteEsm(block.join("\n"))) {
        blocks.push(block.join("\n"));
        block = null;
      } else {
        block.push(line);
      }
      continue;
    }
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (fenceMarker?.[0] === fence[0] && fenceMarker.length >= fence.length) fence = null;
      continue;
    }
    if (fenceMarker) {
      fence = fenceMarker;
      continue;
    }
    if (/^(?:import|export)\s/.test(line)) block = [line];
  }
  if (block) blocks.push(block.join("\n"));
  return blocks.join("\n\n");
}

function isCompleteEsm(code: string): boolean {
  try {
    const result = parseSync("vinext-mdx-esm.jsx", code, { lang: "jsx", sourceType: "module" });
    return !result.errors.some((error) => error.severity === "Error");
  } catch {
    return false;
  }
}
