import fs from "node:fs";
import path from "node:path";
import { manifestFileWithBase } from "./manifest-paths.js";
import type { BuildManifestChunk } from "./lazy-chunks.js";
import { isUnknownRecord } from "./record.js";

type ClientBuildManifest = Record<string, BuildManifestChunk>;

const PAGES_CLIENT_ENTRY_MARKERS = ["vinext-client-entry"];
const CLIENT_ENTRY_MARKERS = [...PAGES_CLIENT_ENTRY_MARKERS, "vinext-app-browser-entry"];

export function readClientBuildManifest(manifestPath: string): ClientBuildManifest | undefined {
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const value: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!isUnknownRecord(value)) return undefined;

    const manifest: ClientBuildManifest = {};
    for (const [key, entry] of Object.entries(value)) {
      if (!isUnknownRecord(entry) || typeof entry.file !== "string") continue;

      const imports = readStringArray(entry.imports);
      const dynamicImports = readStringArray(entry.dynamicImports);
      const css = readStringArray(entry.css);
      const assets = readStringArray(entry.assets);
      manifest[key] = {
        file: entry.file,
        ...(entry.isEntry === true ? { isEntry: true } : {}),
        ...(entry.isDynamicEntry === true ? { isDynamicEntry: true } : {}),
        ...(imports ? { imports } : {}),
        ...(dynamicImports ? { dynamicImports } : {}),
        ...(css ? { css } : {}),
        ...(assets ? { assets } : {}),
      };
    }

    return manifest;
  } catch {
    return undefined;
  }
}

export function findClientEntryFileFromManifest(
  buildManifest: ClientBuildManifest,
  assetBase: string,
): string | undefined {
  return findEntryFileFromManifest(buildManifest, assetBase, CLIENT_ENTRY_MARKERS, true);
}

export function findPagesClientEntryFileFromManifest(
  buildManifest: ClientBuildManifest,
  assetBase: string,
): string | undefined {
  return findEntryFileFromManifest(buildManifest, assetBase, PAGES_CLIENT_ENTRY_MARKERS, false);
}

function findEntryFileFromManifest(
  buildManifest: ClientBuildManifest,
  assetBase: string,
  markers: string[],
  fallbackToFirstEntry: boolean,
): string | undefined {
  const entries = Object.values(buildManifest).filter((entry) => entry.isEntry && entry.file);
  // A client build can emit more than one `isEntry` chunk (e.g. the client
  // entry plus instrumentation or middleware entries), and the manifest's
  // iteration order is not guaranteed to surface the client entry first.
  // Prefer marker order over manifest order so hybrid app+pages builds use the
  // Pages entry for the Pages renderer even if the App entry appears first.
  for (const marker of markers) {
    const markedEntry = entries.find((entry) => entry.file.includes(marker));
    if (markedEntry) return manifestFileWithBase(markedEntry.file, assetBase);
  }

  const chosen = fallbackToFirstEntry ? entries[0] : undefined;

  return chosen ? manifestFileWithBase(chosen.file, assetBase) : undefined;
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function findClientEntryFileInAssetsDir(options: {
  clientDir: string;
  assetsSubdir: string;
  assetBase: string;
  markers: string[];
}): string | undefined {
  const assetsDir = path.join(options.clientDir, options.assetsSubdir);
  if (!fs.existsSync(assetsDir)) return undefined;

  // Walk recursively: client JS entries are emitted under
  // `<assetsSubdir>/chunks/` (see createClientFileNameConfig), not directly in
  // `<assetsSubdir>`. A flat readdir here would miss the entry entirely.
  const files = listFilesRecursive(assetsDir);
  let entryFull: string | undefined;
  for (const marker of options.markers) {
    entryFull = files.find((file) => path.basename(file).includes(marker) && file.endsWith(".js"));
    if (entryFull) break;
  }
  if (!entryFull) return undefined;

  // Return the path relative to clientDir (POSIX-normalised) so it preserves the
  // `<assetsSubdir>/chunks/` location, then apply the basePath.
  const relativeToClient = path.relative(options.clientDir, entryFull).split(path.sep).join("/");
  return manifestFileWithBase(relativeToClient, options.assetBase);
}

export function findClientEntryFile(options: {
  buildManifest?: ClientBuildManifest;
  clientDir: string;
  assetsSubdir: string;
  assetBase: string;
}): string | undefined {
  return (
    (options.buildManifest
      ? findClientEntryFileFromManifest(options.buildManifest, options.assetBase)
      : undefined) ?? findClientEntryFileInAssetsDir({ ...options, markers: CLIENT_ENTRY_MARKERS })
  );
}

export function findPagesClientEntryFile(options: {
  buildManifest?: ClientBuildManifest;
  clientDir: string;
  assetsSubdir: string;
  assetBase: string;
}): string | undefined {
  return (
    (options.buildManifest
      ? findPagesClientEntryFileFromManifest(options.buildManifest, options.assetBase)
      : undefined) ??
    findClientEntryFileInAssetsDir({ ...options, markers: PAGES_CLIENT_ENTRY_MARKERS })
  );
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}
