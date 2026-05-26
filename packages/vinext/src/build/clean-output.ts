import fs from "node:fs";
import path from "node:path";

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

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shouldCleanBuildOutput(options: CleanBuildOutputOptions): boolean {
  if (options.emptyOutDir === false) return false;
  if (options.emptyOutDir === true) return true;

  return isPathInsideOrEqual(
    path.resolve(options.root),
    resolveOutDir(options.root, options.outDir),
  );
}

export function cleanBuildOutput(options: CleanBuildOutputOptions): CleanBuildOutputResult {
  const outDir = resolveOutDir(options.root, options.outDir);
  if (!shouldCleanBuildOutput(options)) return { cleaned: false, outDir };

  fs.rmSync(outDir, { recursive: true, force: true });
  return { cleaned: true, outDir };
}
