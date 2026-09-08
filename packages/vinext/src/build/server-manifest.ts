/**
 * Shared utilities for reading/writing vinext-server.json.
 *
 * Kept in a separate file so both build-time code (prerender.ts) and
 * runtime code (prod-server.ts) can import it without creating a circular
 * dependency.
 */

import path from "pathslash";
import { readJsonFile } from "../utils/safe-json-file.js";

/**
 * Read the prerender secret from `vinext-server.json` in `serverDir`.
 *
 * Returns `undefined` if the file does not exist or cannot be parsed.
 * Callers that require a secret (i.e. the prerender phase itself) should
 * warn when this returns `undefined`.
 */
export function readPrerenderSecret(serverDir: string): string | undefined {
  const manifestPath = path.join(serverDir, "vinext-server.json");
  const manifest = readJsonFile<{ prerenderSecret?: string }>(manifestPath);
  return manifest?.prerenderSecret;
}

/**
 * Read every server output root that contains a deployable response-stage
 * graph. Paths are stored relative to the project root so build artifacts stay
 * relocatable, then resolved for post-build sidecar updates.
 */
export function readServerRuntimeOutputDirs(serverDir: string, root: string): string[] {
  const manifestPath = path.join(serverDir, "vinext-server.json");
  const manifest = readJsonFile<{ runtimeOutputDirs?: unknown }>(manifestPath);
  if (!Array.isArray(manifest?.runtimeOutputDirs)) return [];
  return manifest.runtimeOutputDirs
    .filter((outputDir): outputDir is string => typeof outputDir === "string")
    .map((outputDir) => path.resolve(root, outputDir));
}
