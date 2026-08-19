import type { EnvironmentModuleGraph, EnvironmentModuleNode, ViteDevServer } from "vite";
import type { ModuleImporter } from "./instrumentation.js";
import { escapeHtmlAttr } from "./html.js";
import { getManifestFilesForModule } from "./pages-asset-tags.js";
import { createPagesDevAssetUrl, createPagesDevModuleUrl } from "./pages-dev-module-url.js";

const DEV_STYLESHEET_ASSET_RE = /\.(?:css|scss|sass)$/i;
const DEV_STYLESHEET_MODULE_RE = /\.(?:css|scss|sass)(?:$|[?#])/i;
// These Vite query modes replace the imported module instead of executing it
// in the current document. `inline` and `direct` only have that meaning for
// stylesheets; plain JavaScript carrying those queries still executes. Vite's
// asset and worker loader matchers require bare flags. Its broader
// SPECIAL_QUERY_RE uses `\b` only to filter unrelated plugin hooks; it does
// not define loader behavior. Thus `?raw=false` still executes as JavaScript.
const NON_EXECUTING_MODULE_QUERY_RE = /[?&](?:raw|url|worker|sharedworker)(?:&|$)/;
const NON_INJECTING_STYLESHEET_QUERY_RE = /[?&](?:raw|url|worker|sharedworker|inline|direct)\b/;

type PagesClientAssetsModule = {
  default?: {
    ssrManifest?: Record<string, string[]>;
  };
};

type PagesDevStylesheetAsset = {
  href: string;
  viteDevId: string | null;
};

export function isViteStylesheetGraphTraversalBoundary(
  moduleNode: Pick<EnvironmentModuleNode, "url">,
): boolean {
  return (
    NON_EXECUTING_MODULE_QUERY_RE.test(moduleNode.url) ||
    (DEV_STYLESHEET_MODULE_RE.test(moduleNode.url) &&
      NON_INJECTING_STYLESHEET_QUERY_RE.test(moduleNode.url))
  );
}

export function isViteInjectedStylesheetModule(
  moduleNode: Pick<EnvironmentModuleNode, "type" | "url">,
): boolean {
  return (
    !isViteStylesheetGraphTraversalBoundary(moduleNode) &&
    (moduleNode.type === "css" || DEV_STYLESHEET_MODULE_RE.test(moduleNode.url))
  );
}

const transformedStylesheetAssetsCache = new WeakMap<
  ViteDevServer,
  Map<string, readonly PagesDevStylesheetAsset[]>
>();
const transformedStylesheetAssetsWatchers = new WeakSet<ViteDevServer>();

function adoptableViteDevId(id: string | null | undefined): string | null {
  // Vite passes its resolved transform id, including any query, straight to
  // updateStyle(). A null byte cannot survive HTML parsing, so virtual ids
  // using Rollup's \0 convention cannot be adopted by a server-rendered tag.
  return id && !id.includes("\0") ? id : null;
}

/** Resolve the exact id Vite's CSS transform passes to updateStyle(). */
export async function resolvePagesDevStylesheetId(
  moduleGraph: Pick<EnvironmentModuleGraph, "resolveUrl">,
  url: string,
  resolvedId?: string | null,
): Promise<string | null> {
  const knownId = adoptableViteDevId(resolvedId);
  if (knownId) return knownId;
  if (resolvedId?.includes("\0")) return null;

  try {
    // Vite's transform middleware decodes the request URL before handing it
    // to the module graph. Do the same for manifest-only assets that have not
    // passed through transformRequest yet.
    const [, id] = await moduleGraph.resolveUrl(decodeURI(url));
    return adoptableViteDevId(id);
  } catch {
    return null;
  }
}

async function collectManifestStylesheetAssets(
  server: ViteDevServer,
  runner: ModuleImporter,
  moduleIds: (string | null | undefined)[],
): Promise<PagesDevStylesheetAsset[]> {
  let ssrManifest: Record<string, string[]> | undefined;
  try {
    const pagesClientAssets = (await runner.import(
      "virtual:vinext-pages-client-assets",
    )) as PagesClientAssetsModule;
    ssrManifest = pagesClientAssets.default?.ssrManifest;
  } catch {
    return [];
  }
  if (!ssrManifest || moduleIds.length === 0) return [];

  const moduleGraph = server.environments.client?.moduleGraph;
  const seen = new Set<string>();
  const assets: PagesDevStylesheetAsset[] = [];
  for (const moduleId of moduleIds) {
    const files = getManifestFilesForModule(ssrManifest, moduleId);
    if (!files) continue;
    for (const file of files) {
      if (!DEV_STYLESHEET_ASSET_RE.test(file) || seen.has(file)) continue;
      seen.add(file);
      const href = createPagesDevAssetUrl(file);
      assets.push({
        href,
        viteDevId: moduleGraph ? await resolvePagesDevStylesheetId(moduleGraph, href) : null,
      });
    }
  }
  return assets;
}

async function collectTransformedStylesheetAssets(
  server: ViteDevServer,
  moduleIds: (string | null | undefined)[],
): Promise<readonly PagesDevStylesheetAsset[]> {
  const clientEnvironment = server.environments.client;
  if (!clientEnvironment) return [];

  const cachedServerAssets = transformedStylesheetAssetsCache.get(server);
  const cache = cachedServerAssets ?? new Map<string, readonly PagesDevStylesheetAsset[]>();
  if (!cachedServerAssets) transformedStylesheetAssetsCache.set(server, cache);
  if (!transformedStylesheetAssetsWatchers.has(server)) {
    transformedStylesheetAssetsWatchers.add(server);
    const clearCache = () => cache.clear();
    server.watcher.on("add", clearCache);
    server.watcher.on("change", clearCache);
    server.watcher.on("unlink", clearCache);
  }

  const cacheKey = moduleIds.filter((moduleId): moduleId is string => Boolean(moduleId)).join("\0");
  const cachedAssets = cache.get(cacheKey);
  if (cachedAssets) return cachedAssets;

  const assets: PagesDevStylesheetAsset[] = [];
  const assetKeyIndexes = new Map<string, number>();
  const seenModules = new Set<string>();
  async function addStylesheet(moduleNode: EnvironmentModuleNode): Promise<void> {
    const href = createViteStylesheetHref(moduleNode.url);
    const viteDevId = await resolvePagesDevStylesheetId(
      clientEnvironment.moduleGraph,
      moduleNode.url,
      moduleNode.id,
    );
    appendStylesheetAsset(assets, assetKeyIndexes, {
      href,
      viteDevId,
    });
  }
  async function visitModule(moduleUrl: string): Promise<void> {
    if (seenModules.has(moduleUrl)) return;
    seenModules.add(moduleUrl);
    try {
      await clientEnvironment.transformRequest(moduleUrl);
      const moduleNode = await clientEnvironment.moduleGraph.getModuleByUrl(moduleUrl);
      if (!moduleNode) return;
      for (const importedModule of moduleNode.importedModules) {
        // Vite can retain the underlying CSS file as a graph dependency of a
        // special-query wrapper (for example, `style.css?raw` points at
        // `style.css`). The browser does not execute that file as a stylesheet,
        // so the wrapper is also a traversal boundary.
        if (isViteStylesheetGraphTraversalBoundary(importedModule)) continue;
        if (isViteInjectedStylesheetModule(importedModule)) {
          if (!importedModule.url.startsWith("//")) await addStylesheet(importedModule);
        } else if (importedModule.type === "js") {
          await visitModule(importedModule.url);
        }
      }
    } catch {
      // Preserve the source-manifest fallback when a third-party client
      // transform fails while the server render itself remains valid.
    }
  }

  for (const moduleId of moduleIds) {
    if (!moduleId) continue;
    await visitModule(createPagesDevModuleUrl(server.config.root, moduleId, "/"));
  }
  const result = assets;
  cache.set(cacheKey, result);
  return result;
}

function createViteStylesheetHref(moduleUrl: string): string {
  if (moduleUrl.startsWith("/")) return moduleUrl;

  // This mirrors Vite's wrapId(). Custom and null-byte virtual ids are not
  // browser URLs, so request their CSS through /@id/ in direct mode. Null-byte
  // ids still cannot be adopted because HTML parsing cannot preserve the id;
  // the link nevertheless provides the initial server-rendered stylesheet.
  const wrappedId = `/@id/${moduleUrl.replace("\0", "__x00__")}`;
  return `${wrappedId}${moduleUrl.includes("?") ? "&" : "?"}direct`;
}

function canonicalStylesheetUrl(url: string): string {
  try {
    // decodeURI normalizes spaces while preserving encoded path separators.
    return decodeURI(url);
  } catch {
    return url;
  }
}

function stylesheetAssetKeys(asset: PagesDevStylesheetAsset): string[] {
  const keys = [`url:${canonicalStylesheetUrl(asset.href)}`];
  if (asset.viteDevId) keys.unshift(`id:${asset.viteDevId}`);
  return keys;
}

function appendStylesheetAsset(
  assets: PagesDevStylesheetAsset[],
  keyIndexes: Map<string, number>,
  asset: PagesDevStylesheetAsset,
): void {
  const keys = stylesheetAssetKeys(asset);
  const existingIndex = keys
    .map((key) => keyIndexes.get(key))
    .find((index): index is number => index !== undefined);

  if (existingIndex !== undefined) {
    // A manifest-only resolution can fail before transforming the client
    // graph. Prefer the later graph asset so Vite can adopt the emitted link.
    if (!assets[existingIndex].viteDevId && asset.viteDevId) {
      assets[existingIndex] = asset;
    }
    for (const key of keys) keyIndexes.set(key, existingIndex);
    return;
  }

  const index = assets.length;
  assets.push(asset);
  for (const key of keys) keyIndexes.set(key, index);
}

export async function collectPagesDevInitialStylesheetHeadHTML(
  server: ViteDevServer,
  runner: ModuleImporter,
  moduleIds: (string | null | undefined)[],
  nonceAttr: string,
): Promise<string> {
  const manifestAssets = await collectManifestStylesheetAssets(server, runner, moduleIds);
  const transformedAssets = await collectTransformedStylesheetAssets(server, moduleIds);
  const assets: PagesDevStylesheetAsset[] = [];
  const assetKeyIndexes = new Map<string, number>();
  for (const asset of [...manifestAssets, ...transformedAssets]) {
    appendStylesheetAsset(assets, assetKeyIndexes, asset);
  }

  let html = "";
  for (const { href, viteDevId } of assets) {
    const viteDevIdAttr = viteDevId ? ` data-vite-dev-id="${escapeHtmlAttr(viteDevId)}"` : "";
    html += `<link rel="stylesheet"${nonceAttr}${viteDevIdAttr} href="${escapeHtmlAttr(href)}" />\n  `;
  }
  return html;
}
