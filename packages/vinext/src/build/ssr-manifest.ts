import fs from "node:fs";
import path, { toSlash } from "pathslash";
import { collapseDuplicateBase, manifestFileWithBase } from "../utils/manifest-paths.js";

export type BundleBackfillChunk = {
  type: "chunk";
  fileName: string;
  imports?: string[];
  modules?: Record<string, unknown>;
  viteMetadata?: {
    importedCss?: Set<string>;
    importedAssets?: Set<string>;
  };
};

/**
 * Realpath with NATIVE separators (backslashes on Windows). Callers apply
 * `toSlash` where the result becomes a module id / manifest key.
 */
export function tryRealpathSync(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return null;
  }
}

function isWindowsAbsolutePath(candidate: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith("\\\\");
}

export function relativeWithinRoot(root: string, moduleId: string): string | null {
  // pathslash's `relative` emits forward slashes and (via native win32
  // semantics) tolerates mixed separators / drive-letter casing on Windows.
  // On POSIX it is plain posix.relative, so Windows-style absolute inputs
  // still need routing through the (also slash-emitting) win32 variant.
  const useWindowsPath = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(moduleId);
  const relativeId = useWindowsPath
    ? path.win32.relative(root, moduleId)
    : path.relative(root, moduleId);
  // path.relative(root, root) returns "", which is not a usable manifest key and should be
  // treated the same as "outside root" for this helper.
  if (!relativeId || relativeId === ".." || relativeId.startsWith("../")) return null;
  return relativeId;
}

function normalizeManifestModuleId(moduleId: string, root: string): string {
  // Rollup/Vite hand us ids with native separators; manifest keys are
  // forward-slash. toSlash is a no-op on POSIX (backslash is a legal filename
  // character there) and leaves \\?\-verbatim paths untouched.
  const normalizedId = toSlash(moduleId);
  if (normalizedId.startsWith("\0")) return normalizedId;
  if (normalizedId.startsWith("node_modules/") || normalizedId.includes("/node_modules/")) {
    return normalizedId;
  }

  if (!isWindowsAbsolutePath(moduleId) && !path.isAbsolute(moduleId)) {
    if (!normalizedId.startsWith(".") && !normalizedId.includes("../")) {
      // Preserve bare specifiers like "pages/counter.tsx". These are already
      // stable manifest keys and resolving them against root would rewrite them
      // into filesystem paths that no longer match the bundle/module graph.
      return normalizedId;
    }
  }

  const rootCandidates = new Set<string>([root]);
  const realRoot = tryRealpathSync(root);
  if (realRoot) rootCandidates.add(toSlash(realRoot));

  const moduleCandidates = new Set<string>();
  if (isWindowsAbsolutePath(moduleId) || path.isAbsolute(moduleId)) {
    moduleCandidates.add(moduleId);
  } else {
    moduleCandidates.add(path.resolve(root, moduleId));
  }

  for (const candidate of moduleCandidates) {
    const realCandidate = tryRealpathSync(candidate);
    // Set iteration stays live as entries are appended, so this also checks the
    // realpath variant without needing a second pass or an intermediate array.
    if (realCandidate) moduleCandidates.add(toSlash(realCandidate));
  }

  for (const rootCandidate of rootCandidates) {
    for (const moduleCandidate of moduleCandidates) {
      const relativeId = relativeWithinRoot(rootCandidate, moduleCandidate);
      if (relativeId) return relativeId;
    }
  }

  return normalizedId;
}

export function augmentSsrManifestFromBundle(
  ssrManifest: Record<string, string[]>,
  bundle: Record<string, BundleBackfillChunk | { type: string }>,
  root: string,
  base = "/",
): Record<string, string[]> {
  const nextManifest = {} as Record<string, Set<string>>;

  for (const [key, files] of Object.entries(ssrManifest)) {
    const normalizedKey = normalizeManifestModuleId(key, root);
    if (!nextManifest[normalizedKey]) nextManifest[normalizedKey] = new Set<string>();
    for (const file of files) {
      nextManifest[normalizedKey].add(collapseDuplicateBase(file, base));
    }
  }

  for (const item of Object.values(bundle)) {
    if (item.type !== "chunk") continue;
    const chunk = item as BundleBackfillChunk;

    const files = new Set<string>();
    files.add(manifestFileWithBase(chunk.fileName, base));
    for (const importedFile of chunk.imports ?? []) {
      files.add(manifestFileWithBase(importedFile, base));
    }
    for (const cssFile of chunk.viteMetadata?.importedCss ?? []) {
      files.add(manifestFileWithBase(cssFile, base));
    }
    for (const assetFile of chunk.viteMetadata?.importedAssets ?? []) {
      files.add(manifestFileWithBase(assetFile, base));
    }

    for (const moduleId of Object.keys(chunk.modules ?? {})) {
      const key = normalizeManifestModuleId(moduleId, root);
      if (key.startsWith("node_modules/") || key.includes("/node_modules/")) continue;
      if (key.startsWith("\0")) continue;
      if (!nextManifest[key]) nextManifest[key] = new Set<string>();
      for (const file of files) {
        nextManifest[key].add(file);
      }
    }
  }

  return Object.fromEntries(
    Object.entries(nextManifest).map(([key, files]) => [key, [...files]]),
  ) as Record<string, string[]>;
}
