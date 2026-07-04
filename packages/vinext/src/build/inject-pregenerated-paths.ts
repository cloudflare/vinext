import fs from "node:fs";
import path from "node:path";
import {
  buildPregeneratedConcretePathTable,
  readPrerenderManifest,
} from "../server/prerender-manifest.js";
import { acknowledgeServerEntryMetadataRewrite } from "../server/prod-server.js";
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

export function injectPregeneratedConcretePaths(root: string): void {
  const workerEntry = path.resolve(root, "dist", "server", "index.js");
  if (!fs.existsSync(workerEntry)) return;

  const originalCode = fs.readFileSync(workerEntry, "utf-8");
  let code = originalCode.replace(VINEXT_PREGEN_RE, "");

  const manifestPath = path.join(root, "dist", "server", "vinext-prerender.json");
  const manifest = readPrerenderManifest(manifestPath);
  const table =
    manifest?.pregeneratedConcretePaths ?? buildPregeneratedConcretePathTable(manifest ?? {});

  if (table.length > 0) {
    const injection =
      `${VINEXT_PREGEN_START}\n` +
      `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
      `${VINEXT_PREGEN_END}\n`;
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
    code = injection + code;
  } else {
    delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  }

  if (code === originalCode) return;

  const beforeRewriteMtime = fs.statSync(workerEntry).mtimeMs;
  fs.writeFileSync(workerEntry, code);
  acknowledgeServerEntryMetadataRewrite(workerEntry, beforeRewriteMtime);
}
