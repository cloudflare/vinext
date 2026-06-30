import fs from "node:fs";
import path from "node:path";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import { escapeRegExp } from "../utils/regex.js";

const VINEXT_PREGEN_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const VINEXT_PREGEN_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";
const VINEXT_PREGEN_RE = new RegExp(
  `${escapeRegExp(VINEXT_PREGEN_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREGEN_END)}\\n?`,
  "g",
);

export function injectPregeneratedConcretePaths(root: string): void {
  const workerEntry = path.resolve(root, "dist", "server", "index.js");
  if (!fs.existsSync(workerEntry)) return;

  let code = fs.readFileSync(workerEntry, "utf-8").replace(VINEXT_PREGEN_RE, "");
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const table = manifest?.pregeneratedConcretePaths ?? [];

  if (table.length > 0) {
    code =
      `${VINEXT_PREGEN_START}\n` +
      `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n` +
      `${VINEXT_PREGEN_END}\n` +
      code;
  }

  fs.writeFileSync(workerEntry, code);
}
