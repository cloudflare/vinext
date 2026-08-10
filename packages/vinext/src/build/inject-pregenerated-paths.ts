import fs from "node:fs";
import path from "pathslash";
import { readPrerenderManifest } from "../server/prerender-manifest.js";
import { escapeRegExp } from "../utils/regex.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
  var __VINEXT_PREFETCH_HINTS__: Record<string, unknown> | undefined;
}

const VINEXT_PREGEN_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const VINEXT_PREGEN_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";
const VINEXT_PREGEN_RE = new RegExp(
  `${escapeRegExp(VINEXT_PREGEN_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREGEN_END)}\\n?`,
  "g",
);
const VINEXT_PREFETCH_HINTS_START = "/* __VINEXT_PREFETCH_HINTS_START__ */";
const VINEXT_PREFETCH_HINTS_END = "/* __VINEXT_PREFETCH_HINTS_END__ */";
const VINEXT_PREFETCH_HINTS_RE = new RegExp(
  `${escapeRegExp(VINEXT_PREFETCH_HINTS_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREFETCH_HINTS_END)}\\n?`,
  "g",
);

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function injectPregeneratedConcretePaths(root: string): void {
  const workerEntry = path.resolve(root, "dist", "server", "index.js");
  if (!fs.existsSync(workerEntry)) return;

  let code = fs
    .readFileSync(workerEntry, "utf-8")
    .replace(VINEXT_PREGEN_RE, "")
    .replace(VINEXT_PREFETCH_HINTS_RE, "");
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const table = manifest?.pregeneratedConcretePaths ?? [];
  const prefetchHints = manifest?.prefetchHints ?? {};

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

  if (Object.keys(prefetchHints).length > 0) {
    globalThis.__VINEXT_PREFETCH_HINTS__ = deepFreeze(prefetchHints);
    const serializedPrefetchHints = JSON.stringify(prefetchHints);
    code =
      `${VINEXT_PREFETCH_HINTS_START}\n` +
      `globalThis.__VINEXT_PREFETCH_HINTS__ = (() => { const v = ${serializedPrefetchHints}; const f = (x) => { if (typeof x !== "object" || x === null || Object.isFrozen(x)) return x; for (const y of Object.values(x)) f(y); return Object.freeze(x); }; return f(v); })();\n` +
      `${VINEXT_PREFETCH_HINTS_END}\n` +
      code;
  } else {
    delete globalThis.__VINEXT_PREFETCH_HINTS__;
  }

  fs.writeFileSync(workerEntry, code);
}
