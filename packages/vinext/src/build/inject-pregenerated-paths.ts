import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "pathslash";
import { getPrewarmableAppPaths, readPrerenderManifest } from "../server/prerender-manifest.js";
import { normalizeRscPrewarmPath } from "../utils/rsc-prewarm-path.js";
import { isAbsoluteAssetPrefix, resolveAssetsDir } from "../utils/asset-prefix.js";
import { renderVinextBuiltUrl } from "../utils/built-asset-url.js";
import { escapeRegExp } from "../utils/regex.js";
import { injectRscPrewarmManifestMetaHtml } from "../server/app-rsc-prewarm-meta.js";

declare global {
  var __VINEXT_PREGENERATED_CONCRETE_PATHS: unknown;
  var __VINEXT_RSC_PREWARM_MANIFEST_URL: unknown;
  var __VINEXT_RSC_PREWARMABLE_PATHS: unknown;
}

const VINEXT_PREGEN_START = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_START__ */";
const VINEXT_PREGEN_END = "/* __VINEXT_PREGENERATED_CONCRETE_PATHS_END__ */";
const VINEXT_PREGEN_RE = new RegExp(
  `${escapeRegExp(VINEXT_PREGEN_START)}[\\s\\S]*?${escapeRegExp(VINEXT_PREGEN_END)}\\n?`,
  "g",
);
const VINEXT_PREGENERATED_TABLE_ASSIGNMENT_RE =
  /globalThis\.__VINEXT_PREGENERATED_CONCRETE_PATHS = [^\n]+;\n?/;

const RSC_PREWARM_MANIFEST_PREFIX = "vinext-rsc-prewarm-";

function emitRscPrewarmManifest(
  root: string,
  paths: string[],
  options: { assetPrefix?: string; deploymentId?: string },
): string | undefined {
  const assetPrefix = options.assetPrefix ?? "";
  const assetsDir = path.join(root, "dist", "client", resolveAssetsDir(assetPrefix));
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      if (name.startsWith(RSC_PREWARM_MANIFEST_PREFIX) && name.endsWith(".json")) {
        fs.rmSync(path.join(assetsDir, name), { force: true });
      }
    }
  }
  if (paths.length === 0) return undefined;

  const content = JSON.stringify({ version: 1, paths }) + "\n";
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  const fileName = `${RSC_PREWARM_MANIFEST_PREFIX}${hash}.json`;
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, fileName), content, "utf-8");
  // This manifest controls whether browser requests may use the canonical
  // warmed RSC shape. Keep it on the deployment origin so an external asset
  // CDN never adds a CORS or CSP connect-src dependency to navigation.
  const controlAssetPrefix = isAbsoluteAssetPrefix(assetPrefix) ? "" : assetPrefix;
  return renderVinextBuiltUrl(
    `${resolveAssetsDir(assetPrefix)}/${fileName}`,
    controlAssetPrefix,
    options.deploymentId,
    "html",
  );
}

function injectRscPrewarmMetaIntoHtmlFiles(directory: string): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      injectRscPrewarmMetaIntoHtmlFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".html")) {
      const html = fs.readFileSync(entryPath, "utf-8");
      const injected = injectRscPrewarmManifestMetaHtml(html);
      if (injected !== html) fs.writeFileSync(entryPath, injected, "utf-8");
    }
  }
}

export function injectPregeneratedConcretePaths(
  root: string,
  options: {
    assetPrefix?: string;
    deploymentId?: string;
    emitRscPrewarmManifest?: boolean;
    includePregeneratedConcretePaths?: boolean;
    preservePregeneratedConcretePaths?: boolean;
  } = {},
): void {
  const workerEntry = path.resolve(root, "dist", "server", "index.js");
  const manifest = readPrerenderManifest(
    path.join(root, "dist", "server", "vinext-prerender.json"),
  );
  const preservePregeneratedConcretePaths = options.preservePregeneratedConcretePaths === true;
  const table =
    preservePregeneratedConcretePaths || options.includePregeneratedConcretePaths === false
      ? []
      : (manifest?.pregeneratedConcretePaths ?? []);
  const prewarmablePaths =
    options.emitRscPrewarmManifest && manifest
      ? getPrewarmableAppPaths(manifest).map((pathname) => normalizeRscPrewarmPath(pathname))
      : [];
  const prewarmManifestUrl = emitRscPrewarmManifest(root, prewarmablePaths, options);

  if (!preservePregeneratedConcretePaths) {
    if (table.length > 0) {
      globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = table;
    } else {
      delete globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS;
    }
  }
  if (prewarmManifestUrl) {
    globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL = prewarmManifestUrl;
    globalThis.__VINEXT_RSC_PREWARMABLE_PATHS = prewarmablePaths;
  } else {
    delete globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL;
    delete globalThis.__VINEXT_RSC_PREWARMABLE_PATHS;
  }

  injectRscPrewarmMetaIntoHtmlFiles(path.join(root, "dist", "server", "prerendered-routes"));
  injectRscPrewarmMetaIntoHtmlFiles(path.join(root, "dist", "client"));

  if (!fs.existsSync(workerEntry)) return;
  const originalCode = fs.readFileSync(workerEntry, "utf-8");
  const preservedTableAssignment = preservePregeneratedConcretePaths
    ? (originalCode.match(VINEXT_PREGENERATED_TABLE_ASSIGNMENT_RE)?.[0] ?? "")
    : "";
  let code = originalCode.replace(VINEXT_PREGEN_RE, "");

  if (table.length > 0 || preservedTableAssignment || prewarmManifestUrl) {
    code =
      `${VINEXT_PREGEN_START}\n` +
      (preservedTableAssignment ||
        (table.length > 0
          ? `globalThis.__VINEXT_PREGENERATED_CONCRETE_PATHS = ${JSON.stringify(table)};\n`
          : "")) +
      (prewarmManifestUrl
        ? `globalThis.__VINEXT_RSC_PREWARM_MANIFEST_URL = ${JSON.stringify(prewarmManifestUrl)};\n`
        : "") +
      (prewarmablePaths.length > 0
        ? `globalThis.__VINEXT_RSC_PREWARMABLE_PATHS = ${JSON.stringify(prewarmablePaths)};\n`
        : "") +
      `${VINEXT_PREGEN_END}\n` +
      code;
  }

  fs.writeFileSync(workerEntry, code);
}
