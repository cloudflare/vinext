import fs from "node:fs";
import path from "pathslash";
import { isPathInsideOrEqual } from "../utils/path.js";

type CleanBuildOutputOptions = {
  root: string;
  outDir?: string;
  emptyOutDir?: boolean;
};

type CleanBuildOutputResult = {
  cleaned: boolean;
  outDir: string;
};

function resolveOutDir(root: string, outDir: string | undefined): string {
  const resolvedRoot = path.resolve(root);
  if (!outDir) return path.join(resolvedRoot, "dist");
  return path.isAbsolute(outDir) ? outDir : path.resolve(resolvedRoot, outDir);
}

function shouldCleanBuildOutput(options: CleanBuildOutputOptions): boolean {
  const root = path.resolve(options.root);
  const outDir = resolveOutDir(options.root, options.outDir);
  // A `build.outDir` of "." (or any directory containing the project) would
  // delete the project itself, source and .git included.
  if (isPathInsideOrEqual(outDir, root)) return false;
  if (options.emptyOutDir === false) return false;
  if (options.emptyOutDir === true) return true;

  // As Vite does, empty only an outDir inside the project root by default.
  return isPathInsideOrEqual(root, outDir);
}

export function cleanBuildOutput(options: CleanBuildOutputOptions): CleanBuildOutputResult {
  const outDir = resolveOutDir(options.root, options.outDir);
  if (!shouldCleanBuildOutput(options)) return { cleaned: false, outDir };

  fs.rmSync(outDir, { recursive: true, force: true });
  return { cleaned: true, outDir };
}
