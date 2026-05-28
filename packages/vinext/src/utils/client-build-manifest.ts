import fs from "node:fs";
import path from "node:path";
import { manifestFileWithBase } from "./manifest-paths.js";
import type { BuildManifestChunk } from "./lazy-chunks.js";
import { isUnknownRecord } from "./record.js";

type ClientBuildManifest = Record<string, BuildManifestChunk>;

const CLIENT_ENTRY_MARKERS = ["vinext-client-entry", "vinext-app-browser-entry"] as const;

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
  for (const entry of Object.values(buildManifest)) {
    if (entry.isEntry && entry.file) {
      return manifestFileWithBase(entry.file, assetBase);
    }
  }

  return undefined;
}

function findClientEntryFileInAssetsDir(options: {
  clientDir: string;
  assetsSubdir: string;
  assetBase: string;
}): string | undefined {
  const assetsDir = path.join(options.clientDir, options.assetsSubdir);
  if (!fs.existsSync(assetsDir)) return undefined;

  const entry = fs
    .readdirSync(assetsDir)
    .find(
      (file) =>
        CLIENT_ENTRY_MARKERS.some((marker) => file.includes(marker)) && file.endsWith(".js"),
    );

  return entry
    ? manifestFileWithBase(`${options.assetsSubdir}/${entry}`, options.assetBase)
    : undefined;
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
      : undefined) ?? findClientEntryFileInAssetsDir(options)
  );
}

function readStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}
