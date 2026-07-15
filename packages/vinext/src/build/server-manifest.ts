/**
 * Shared utilities for reading/writing vinext-server.json.
 *
 * Kept in a separate file so both build-time code (prerender.ts) and
 * runtime code (prod-server.ts) can import it without creating a circular
 * dependency.
 */

import path from "pathslash";
import { readJsonFile } from "../utils/safe-json-file.js";

export type VinextServerManifest = {
  /**
   * Whether the built app contains any server action references. Absent in
   * manifests written before the flag existed or by builds without an rsc
   * environment; readers must treat absence as "actions may exist".
   */
  hasServerActions?: boolean;
  prerenderSecret?: string;
};

/**
 * Read `vinext-server.json` from `serverDir`.
 *
 * Returns `undefined` if the file does not exist or cannot be parsed.
 */
export function readServerManifest(serverDir: string): VinextServerManifest | undefined {
  const manifestPath = path.join(serverDir, "vinext-server.json");
  return readJsonFile<VinextServerManifest>(manifestPath) ?? undefined;
}

/**
 * Read the prerender secret from `vinext-server.json` in `serverDir`.
 *
 * Returns `undefined` if the file does not exist or cannot be parsed.
 * Callers that require a secret (i.e. the prerender phase itself) should
 * warn when this returns `undefined`.
 */
export function readPrerenderSecret(serverDir: string): string | undefined {
  return readServerManifest(serverDir)?.prerenderSecret;
}
