import fs from "node:fs";
import path from "pathslash";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import { escapeRegExp } from "../utils/regex.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
  var __VINEXT_PARTIAL_PRERENDER_PATHS: unknown;
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

  let code = fs.readFileSync(workerEntry, "utf-8").replace(VINEXT_PREGEN_RE, "");
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const table = manifest?.pregeneratedConcretePaths ?? [];
  const partialPaths = manifest?.partialPrerenderPaths ?? [];
  const assignments: string[] = [];

  if (table.length > 0) {
    globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
    assignments.push(`globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};`);
  } else {
    delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
  }

  if (partialPaths.length > 0) {
    globalThis.__VINEXT_PARTIAL_PRERENDER_PATHS = partialPaths;
    assignments.push(
      `globalThis.__VINEXT_PARTIAL_PRERENDER_PATHS = ${JSON.stringify(partialPaths)};`,
    );
  } else {
    delete globalThis.__VINEXT_PARTIAL_PRERENDER_PATHS;
  }

  if (assignments.length > 0) {
    code = `${VINEXT_PREGEN_START}\n${assignments.join("\n")}\n${VINEXT_PREGEN_END}\n${code}`;
  }

  fs.writeFileSync(workerEntry, code);
}
