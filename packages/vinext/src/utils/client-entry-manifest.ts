import fs from "node:fs";
import path from "node:path";
import { manifestFileWithBase } from "./manifest-paths.js";
import { isUnknownRecord } from "./record.js";

export const VINEXT_CLIENT_ENTRY_MANIFEST = "vinext-client-entry-manifest.json";

export type ClientEntryManifest = {
  pagesClientEntry?: string;
  appBrowserEntry?: string;
};

export function readClientEntryManifest(clientDir: string): ClientEntryManifest | undefined {
  const manifestPath = path.join(clientDir, VINEXT_CLIENT_ENTRY_MANIFEST);
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const value: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (!isUnknownRecord(value)) return undefined;

    const manifest: ClientEntryManifest = {};
    if (typeof value.pagesClientEntry === "string") {
      manifest.pagesClientEntry = value.pagesClientEntry;
    }
    if (typeof value.appBrowserEntry === "string") {
      manifest.appBrowserEntry = value.appBrowserEntry;
    }

    return manifest.pagesClientEntry || manifest.appBrowserEntry ? manifest : undefined;
  } catch {
    return undefined;
  }
}

export function findClientEntryFileFromVinextManifest(
  manifest: ClientEntryManifest | undefined,
  assetBase: string,
): string | undefined {
  const entry = manifest?.pagesClientEntry ?? manifest?.appBrowserEntry;
  return entry ? manifestFileWithBase(entry, assetBase) : undefined;
}

export function findPagesClientEntryFileFromVinextManifest(
  manifest: ClientEntryManifest | undefined,
  assetBase: string,
): string | undefined {
  return manifest?.pagesClientEntry
    ? manifestFileWithBase(manifest.pagesClientEntry, assetBase)
    : undefined;
}
