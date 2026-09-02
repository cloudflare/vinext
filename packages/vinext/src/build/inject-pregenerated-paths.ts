import fs from "node:fs";
import path from "pathslash";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import { PREGENERATED_CONCRETE_PATHS_MODULE } from "../server/pregenerated-concrete-paths.js";
import { readServerRuntimeOutputDirs } from "./server-manifest.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
}

export function injectPregeneratedConcretePaths(
  root: string,
  applicationEntry = path.resolve(root, "dist", "server", "index.js"),
  serverOutputDir = path.resolve(root, "dist", "server"),
  additionalRuntimeDirs: readonly string[] = [],
): void {
  const manifest = readPrerenderManifest(path.join(serverOutputDir, "vinext-prerender.json"));
  const table = manifest?.pregeneratedConcretePaths ?? [];

  // Response-stage entries can be deployed independently of index.js. Keep the
  // table in a stable side-effect module imported by every generated App
  // response graph so those deployments retain the same PPR fallback guard.
  // The file is emitted during the server build; writing it after prerendering
  // updates the artifact without rebuilding or coupling core to a host
  // transport.
  const runtimeModuleCode =
    table.length > 0
      ? `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n`
      : "delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;\n";
  for (const outputDir of new Set([
    serverOutputDir,
    path.dirname(applicationEntry),
    ...additionalRuntimeDirs,
    ...readServerRuntimeOutputDirs(serverOutputDir, root),
  ])) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, PREGENERATED_CONCRETE_PATHS_MODULE), runtimeModuleCode);
  }

  if (table.length > 0) {
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
  } else {
    delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  }
}
