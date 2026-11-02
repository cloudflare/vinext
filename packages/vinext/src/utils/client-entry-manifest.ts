import fs from "node:fs";
import path from "pathslash";
import type { ClientReferenceChunks } from "./client-reference-chunks.js";
import { manifestFileWithBase } from "./manifest-paths.js";
import { isUnknownRecord } from "./record.js";

export const VINEXT_CLIENT_ENTRY_MANIFEST = "vinext-client-entry-manifest.json";
/**
 * Build manifest keys of App Router client reference modules -> the chunk of
 * the module that registers the reference (see build/client-reference-chunks.ts).
 * It names source files, so it sits under `.vite/` with Vite's build manifest,
 * which deploys leave out of the public assets.
 */
export const VINEXT_CLIENT_REFERENCE_SOURCES = ".vite/vinext-client-reference-sources.json";

export type ClientEntryManifest = {
  pagesClientEntry?: string;
  appBrowserEntry?: string;
  /** The App Router RouteManifest chunk, which the browser entry imports as it boots. */
  appRouteManifest?: string;
  /** What each App Router client reference loads in the browser. */
  appClientReferenceChunks?: ClientReferenceChunks;
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
    if (typeof value.appRouteManifest === "string") {
      manifest.appRouteManifest = value.appRouteManifest;
    }
    if (isUnknownRecord(value.appClientReferenceChunks)) {
      // Written by vinext:client-entry-manifest in the same build.
      manifest.appClientReferenceChunks = value.appClientReferenceChunks as ClientReferenceChunks;
    }

    return manifest.pagesClientEntry || manifest.appBrowserEntry ? manifest : undefined;
  } catch {
    return undefined;
  }
}

export function readClientReferenceSources(clientDir: string): Record<string, string> | undefined {
  const sourcesPath = path.join(clientDir, VINEXT_CLIENT_REFERENCE_SOURCES);
  if (!fs.existsSync(sourcesPath)) return undefined;
  try {
    const value: unknown = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
    // Written by vinext:client-entry-manifest in the same build.
    return isUnknownRecord(value) ? (value as Record<string, string>) : undefined;
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
