import type { EnvironmentModuleGraph, EnvironmentModuleNode, ViteDevServer } from "vite";
import type { ModuleImporter } from "./instrumentation.js";
import { escapeHtmlAttr } from "./html.js";
import { getManifestFilesForModule } from "./pages-asset-tags.js";
import { createPagesDevAssetUrl, createPagesDevModuleUrl } from "./pages-dev-module-url.js";

const DEV_STYLESHEET_ASSET_RE = /\.(?:css|scss|sass)$/i;
const DEV_STYLESHEET_MODULE_RE = /\.(?:css|scss|sass)(?:$|[?#])/i;
// These Vite query modes replace the imported module instead of executing it
// in the current document. `inline` and `direct` only have that meaning for
// stylesheets; plain JavaScript carrying those queries still executes.
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

  const assets = new Map<string, PagesDevStylesheetAsset>();
  const seenModules = new Set<string>();
  async function addStylesheet(moduleNode: EnvironmentModuleNode): Promise<void> {
    const href = moduleNode.url.startsWith("\0")
      ? `/@id/__x00__${moduleNode.url.slice(1)}${moduleNode.url.includes("?") ? "&" : "?"}direct`
      : moduleNode.url;
    const viteDevId = await resolvePagesDevStylesheetId(
      clientEnvironment.moduleGraph,
      moduleNode.url,
      moduleNode.id,
    );
    assets.set(viteDevId ? `id:${viteDevId}` : `url:${canonicalStylesheetUrl(href)}`, {
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
  const result = [...assets.values()];
  cache.set(cacheKey, result);
  return result;
}

function canonicalStylesheetUrl(url: string): string {
  try {
    // decodeURI normalizes spaces while preserving encoded path separators.
    return decodeURI(url);
  } catch {
    return url;
  }
}

function stylesheetAssetKey(asset: PagesDevStylesheetAsset): string {
  return asset.viteDevId ? `id:${asset.viteDevId}` : `url:${canonicalStylesheetUrl(asset.href)}`;
}

export async function collectPagesDevInitialStylesheetHeadHTML(
  server: ViteDevServer,
  runner: ModuleImporter,
  moduleIds: (string | null | undefined)[],
  nonceAttr: string,
): Promise<string> {
  const manifestAssets = await collectManifestStylesheetAssets(server, runner, moduleIds);
  const transformedAssets = await collectTransformedStylesheetAssets(server, moduleIds);
  const assets = new Map<string, PagesDevStylesheetAsset>();
  for (const asset of [...manifestAssets, ...transformedAssets]) {
    const key = stylesheetAssetKey(asset);
    if (!assets.has(key)) assets.set(key, asset);
  }

  let html = "";
  for (const { href: rawHref, viteDevId } of assets.values()) {
    const href = rawHref.startsWith("/") ? rawHref : createPagesDevAssetUrl(rawHref);
    const viteDevIdAttr = viteDevId ? ` data-vite-dev-id="${escapeHtmlAttr(viteDevId)}"` : "";
    html += `<link rel="stylesheet"${nonceAttr}${viteDevIdAttr} href="${escapeHtmlAttr(href)}" />\n  `;
  }
  return html;
}
