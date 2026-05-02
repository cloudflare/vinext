import fs from "node:fs";
import path from "node:path";
import { normalizeManifestFile, manifestFileWithBase } from "../utils/manifest-paths.js";

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
  const useWindowsPath = isWindowsAbsolutePath(root) || isWindowsAbsolutePath(moduleId);
  const relativeId = (
    useWindowsPath ? path.win32.relative(root, moduleId) : path.relative(root, moduleId)
  ).replace(/\\/g, "/");
  // path.relative(root, root) returns "", which is not a usable manifest key and should be
  // treated the same as "outside root" for this helper.
  if (!relativeId || relativeId === ".." || relativeId.startsWith("../")) return null;
  return relativeId;
}

function normalizeManifestModuleId(moduleId: string, root: string): string {
  const normalizedId = moduleId.replace(/\\/g, "/");
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
  if (realRoot) rootCandidates.add(realRoot);

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
    if (realCandidate) moduleCandidates.add(realCandidate);
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
      nextManifest[normalizedKey].add(normalizeManifestFile(file));
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
