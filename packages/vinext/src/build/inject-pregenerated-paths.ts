import fs from "node:fs";
import path from "pathslash";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import { PREGENERATED_CONCRETE_PATHS_MODULE } from "../server/pregenerated-concrete-paths.js";
import { escapeRegExp } from "../utils/regex.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
}

const VINEXT_PREGEN_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const VINEXT_PREGEN_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";
const VINEXT_PREGEN_RE = new RegExp(
  `${escapeRegExp(VINEXT_PREGEN_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREGEN_END)}\\n?`,
  "g",
);

export function injectPregeneratedConcretePaths(
  root: string,
  workerEntry = path.resolve(root, "dist", "server", "index.js"),
  serverOutputDir = path.resolve(root, "dist", "server"),
): void {
  const runtimeDir = path.dirname(workerEntry);
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
  for (const outputDir of new Set([serverOutputDir, runtimeDir])) {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, PREGENERATED_CONCRETE_PATHS_MODULE), runtimeModuleCode);
  }

  if (!fs.existsSync(workerEntry)) {
    if (table.length > 0) globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
    else delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
    return;
  }

  let code = fs.readFileSync(workerEntry, "utf-8").replace(VINEXT_PREGEN_RE, "");

  if (table.length > 0) {
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
    code =
      `${VINEXT_PREGEN_START}\n` +
      `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
      `${VINEXT_PREGEN_END}\n` +
      code;
  } else {
    delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  }

  fs.writeFileSync(workerEntry, code);
}
