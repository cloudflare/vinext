import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { isPathInside } from "../utils/path.js";

/**
 * Where a build records the output root it wrote: Vite's `build.outDir` as
 * the resolved config has it, which may come from a plugin's config hook.
 * `vinext start` and `vinext deploy --skip-build` don't resolve the Vite
 * config, so they read it from here.
 */
const RECORD_PATH = path.join(".vinext", "build", "output.json");

/** Record `outDir` as the last build's output root. */
export function recordBuildOutDir(root: string, outDir: string): void {
  const recordPath = path.join(root, RECORD_PATH);
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  // An outDir inside the project is recorded relative to it, so a moved or
  // copied project still finds it.
  const recorded = isPathInside(root, outDir) ? toSlash(path.relative(root, outDir)) : outDir;
  fs.writeFileSync(recordPath, JSON.stringify({ outDir: recorded }));
}

/** The last build's output root, or undefined if no build recorded one. */
export function readRecordedBuildOutDir(root: string): string | undefined {
  let recorded: unknown;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(root, RECORD_PATH), "utf8"));
  } catch {
    return undefined;
  }
  const outDir =
    recorded && typeof recorded === "object"
      ? (recorded as { outDir?: unknown }).outDir
      : undefined;
  return typeof outDir === "string" && outDir !== "" ? path.resolve(root, outDir) : undefined;
}
