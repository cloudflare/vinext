import type { EnvironmentModuleGraph, EnvironmentModuleNode, Plugin, ViteDevServer } from "vite";
import type { SourceDescription } from "vite/rolldown";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import path from "pathslash";
import { createNonceAttribute } from "./html.js";

type PagesHtmlTransformContext = {
  documentUrl: string;
  scriptNonce?: string;
  server: ViteDevServer;
  transformUrl: string;
};
type CapturedProxyModule = {
  code: string;
  map?: SourceDescription["map"];
  moduleSideEffects?: SourceDescription["moduleSideEffects"];
};
type RetainedProxyModule = {
  aliases: string[];
  module: CapturedProxyModule;
};
type EvictableModuleGraph = EnvironmentModuleGraph & {
  _unresolvedUrlToModuleMap?: Map<string, EnvironmentModuleNode | Promise<EnvironmentModuleNode>>;
};

const HTML_PROXY_SCRIPT_RE =
  /<script\b[^>]*\bsrc="([^"]*[?&]html-proxy&index=(\d+)\.js)"[^>]*><\/script>/g;
const CONTENT_MODULE_PREFIX = "__vinext_html_proxy_content_";
const MAX_RETAINED_PROXY_DOCUMENTS = 128;
const MAX_RETAINED_PROXY_VERSIONS = 8;
const pagesHtmlTransformContext = new AsyncLocalStorage<PagesHtmlTransformContext>();
const serverLocks = new WeakMap<ViteDevServer, Map<string, Promise<void>>>();

function cleanUrl(url: string): string {
  return url.replace(/[?#].*$/, "");
}

function documentDirectory(url: string): string {
  const pathname = cleanUrl(url);
  return pathname.endsWith("/") ? pathname : pathname.slice(0, pathname.lastIndexOf("/") + 1);
}

function htmlProxyDocumentId(url: string): string {
  // Vite determines this before stripping the query string. Preserve that
  // order so `/route/` maps to `index.html`, while `/route/?q=1` does not.
  const trailingSlash = url.endsWith("/");
  const pathname = decodeURI(cleanUrl(url));
  return `\0${trailingSlash ? `${pathname}index.html` : pathname}`;
}

function stripBase(url: string, base: string): string {
  if (base === "/" || !url.startsWith(base)) return url;
  return `/${url.slice(base.length)}`;
}

function decodedBase(server: ViteDevServer): string {
  return decodeURI(server.config.base);
}

function unwrapHtmlProxyUrl(url: string, base: string): string | null {
  const withoutBase = stripBase(url, base);
  const prefix = "/@id/__x00__";
  return withoutBase.startsWith(prefix)
    ? decodeURI(`\0${withoutBase.slice(prefix.length)}`)
    : decodeURI(withoutBase);
}

function isActiveHtmlProxyDocument(id: string, url: string): boolean {
  const documentPath = decodeURI(cleanUrl(url));
  const proxyPath = cleanUrl(id);
  return proxyPath === documentPath || proxyPath === htmlProxyDocumentId(url);
}

function contentModuleUrl(
  markerUrl: string,
  hash: string,
  index: number,
  publicBase: string,
): string {
  const documentUrl = `${documentDirectory(markerUrl)}${CONTENT_MODULE_PREFIX}${hash}_${index}.js`;
  if (publicBase === "/") return documentUrl;
  return `${publicBase}${documentUrl.slice(1)}`;
}

function contentModuleId(root: string, publicUrl: string, base: string): string {
  // The content module stays in the document directory, so Vite's normal
  // resolver preserves relative-import semantics without a virtual-importer
  // remapping hook.
  let decodedUrl: string;
  try {
    // Match Vite's URL-to-filesystem conversion: decode ordinary path bytes
    // (including spaces) while leaving encoded separators such as %2F intact.
    decodedUrl = decodeURI(stripBase(publicUrl, base));
  } catch {
    throw new Error(`[vinext] Invalid Pages HTML proxy URL ${publicUrl}`);
  }
  const id = path.resolve(root, `.${decodedUrl}`);
  const relative = path.relative(root, id);
  if (relative === ".." || relative.startsWith("../")) {
    throw new Error(`[vinext] Pages HTML proxy URL escapes the Vite root: ${publicUrl}`);
  }
  return id;
}

async function withDocumentLock<T>(
  server: ViteDevServer,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let locks = serverLocks.get(server);
  if (!locks) {
    locks = new Map();
    serverLocks.set(server, locks);
  }
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

function normalizeLoadedModule(loaded: string | SourceDescription): CapturedProxyModule {
  if (typeof loaded === "string") return { code: loaded };
  return {
    code: loaded.code,
    map: loaded.map,
    moduleSideEffects: loaded.moduleSideEffects,
  };
}

function applyProxyScriptNonce(tag: string, nonce?: string): string {
  if (!nonce) return tag;
  const withoutExistingNonce = tag.replace(/\snonce=(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "");
  return withoutExistingNonce.replace(
    /^<script\b/i,
    (open) => `${open}${createNonceAttribute(nonce)}`,
  );
}

function removeViteModule(
  graph: EvictableModuleGraph,
  module: EnvironmentModuleNode,
  resolvedId: string,
): void {
  graph.invalidateModule(module);
  for (const imported of module.importedModules) imported.importers.delete(module);
  for (const importer of module.importers) {
    importer.importedModules.delete(module);
    importer.acceptedHmrDeps.delete(module);
  }
  module.importedModules.clear();
  module.importers.clear();
  module.acceptedHmrDeps.clear();
  graph.idToModuleMap.delete(resolvedId);
  for (const [url, candidate] of graph.urlToModuleMap) {
    if (candidate === module) graph.urlToModuleMap.delete(url);
  }
  for (const [etag, candidate] of graph.etagToModuleMap) {
    if (candidate === module) graph.etagToModuleMap.delete(etag);
  }
  if (module.file) {
    const fileModules = graph.fileToModulesMap.get(module.file);
    fileModules?.delete(module);
    if (fileModules?.size === 0) graph.fileToModulesMap.delete(module.file);
  }

  // Vite has no public module-removal API. Its unresolved lookup is the last
  // strong reference after the public graph maps above are cleared.
  for (const [url, candidate] of graph._unresolvedUrlToModuleMap ?? []) {
    if (candidate === module) graph._unresolvedUrlToModuleMap!.delete(url);
  }
}

function evictViteModule(server: ViteDevServer, resolvedId: string, aliases: string[]): void {
  const graph: EvictableModuleGraph = server.environments.client.moduleGraph;
  const module = graph.getModuleById(resolvedId);
  if (module) removeViteModule(graph, module, resolvedId);

  const unresolved = graph._unresolvedUrlToModuleMap;
  if (!unresolved) return;
  const aliasSet = new Set(aliases);
  for (const [url, candidate] of unresolved) {
    if (!aliasSet.has(cleanUrl(url)) || !(candidate instanceof Promise)) continue;
    void candidate.then(
      (resolved) => {
        if (resolved.id) removeViteModule(graph, resolved, resolved.id);
      },
      () => {
        if (unresolved.get(url) === candidate) unresolved.delete(url);
      },
    );
  }
}

function evictRetainedProxyModule(
  server: ViteDevServer,
  modules: Map<string, RetainedProxyModule>,
  publicToResolvedId: Map<string, string>,
  resolvedId: string,
): void {
  const retained = modules.get(resolvedId);
  if (!retained) return;
  modules.delete(resolvedId);
  for (const alias of retained.aliases) {
    if (publicToResolvedId.get(alias) === resolvedId) publicToResolvedId.delete(alias);
  }
  evictViteModule(server, resolvedId, retained.aliases);
}

function retainProxyModule(
  server: ViteDevServer,
  modules: Map<string, RetainedProxyModule>,
  publicToResolvedId: Map<string, string>,
  retainedByDocument: Map<string, Map<number, Set<string>>>,
  documentUrl: string,
  index: number,
  resolvedId: string,
  publicUrl: string,
  publicBase: string,
  module: CapturedProxyModule,
): void {
  const aliases = Array.from(
    new Set([cleanUrl(publicUrl), cleanUrl(stripBase(publicUrl, publicBase))]),
  );
  const previous = modules.get(resolvedId);
  if (previous) {
    modules.delete(resolvedId);
    for (const alias of previous.aliases) {
      if (publicToResolvedId.get(alias) === resolvedId) publicToResolvedId.delete(alias);
    }
  }

  modules.set(resolvedId, { aliases, module });
  for (const alias of aliases) publicToResolvedId.set(alias, resolvedId);

  let document = retainedByDocument.get(documentUrl);
  if (document) {
    retainedByDocument.delete(documentUrl);
    retainedByDocument.set(documentUrl, document);
  } else {
    document = new Map();
    retainedByDocument.set(documentUrl, document);
  }
  let retained = document.get(index);
  if (!retained) {
    retained = new Set();
    document.set(index, retained);
  }
  retained.delete(resolvedId);
  retained.add(resolvedId);

  while (retained.size > MAX_RETAINED_PROXY_VERSIONS) {
    const oldestId = retained.keys().next().value;
    if (oldestId === undefined) break;
    retained.delete(oldestId);
    // A browser still fetching HTML older than this bounded dev history may
    // receive a 404, just as a stale tab can after an HMR invalidation.
    evictRetainedProxyModule(server, modules, publicToResolvedId, oldestId);
  }

  while (retainedByDocument.size > MAX_RETAINED_PROXY_DOCUMENTS) {
    const oldestDocumentUrl = retainedByDocument.keys().next().value;
    if (oldestDocumentUrl === undefined) break;
    const oldestDocument = retainedByDocument.get(oldestDocumentUrl)!;
    retainedByDocument.delete(oldestDocumentUrl);
    for (const versions of oldestDocument.values()) {
      for (const oldId of versions) {
        evictRetainedProxyModule(server, modules, publicToResolvedId, oldId);
      }
    }
  }
}

/** Capture Vite's exact proxy sources and rewrite them to immutable modules. */
export function createPagesHtmlProxyCapturePlugin(): Plugin {
  const modules = new Map<string, RetainedProxyModule>();
  const publicToResolvedId = new Map<string, string>();
  const retainedByDocument = new Map<string, Map<number, Set<string>>>();
  return {
    name: "vinext:pages-html-proxy-capture",
    enforce: "pre",
    // Keep this as a normal-order hook: Vite creates its html-proxy scripts in
    // devHtmlHook before normal hooks run. An `order: "pre"` hook cannot see them.
    async transformIndexHtml(html) {
      const active = pagesHtmlTransformContext.getStore();
      if (!active) return;
      const { server } = active;
      const replacements: Array<{ end: number; start: number; value: string }> = [];
      for (const match of html.matchAll(HTML_PROXY_SCRIPT_RE)) {
        const proxyUrl = match[1]!;
        const index = Number(match[2]);
        const publicBase = server.config.base;
        const proxyBase = decodedBase(server);
        const originalId = unwrapHtmlProxyUrl(proxyUrl, proxyBase);
        if (!originalId || !isActiveHtmlProxyDocument(originalId, active.transformUrl)) {
          continue;
        }
        const container = server.environments.client.pluginContainer;
        const resolved = await container.resolveId(originalId);
        if (!resolved) throw new Error(`[vinext] Failed to resolve Pages HTML proxy ${proxyUrl}`);
        const result = await container.load(resolved.id);
        if (!result) throw new Error(`[vinext] Failed to load Pages HTML proxy ${proxyUrl}`);
        const loaded = normalizeLoadedModule(result);
        const identity = JSON.stringify({
          code: loaded.code,
          document: active.documentUrl,
          index,
          map: loaded.map ?? null,
          moduleSideEffects: loaded.moduleSideEffects ?? null,
        });
        const hash = createHash("sha256").update(identity).digest("hex");
        const publicUrl = contentModuleUrl(active.documentUrl, hash, index, publicBase);
        const resolvedId = contentModuleId(server.config.root, publicUrl, publicBase);
        retainProxyModule(
          server,
          modules,
          publicToResolvedId,
          retainedByDocument,
          active.documentUrl,
          index,
          resolvedId,
          publicUrl,
          publicBase,
          loaded,
        );
        replacements.push({
          end: match.index + match[0].length,
          start: match.index,
          value: applyProxyScriptNonce(match[0].replace(proxyUrl, publicUrl), active.scriptNonce),
        });
      }
      let transformedHtml = html;
      for (let index = replacements.length - 1; index >= 0; index -= 1) {
        const replacement = replacements[index]!;
        transformedHtml =
          transformedHtml.slice(0, replacement.start) +
          replacement.value +
          transformedHtml.slice(replacement.end);
      }
      return transformedHtml;
    },
    hotUpdate({ server }) {
      for (const resolvedId of Array.from(modules.keys())) {
        evictRetainedProxyModule(server, modules, publicToResolvedId, resolvedId);
      }
      retainedByDocument.clear();
    },
    resolveId: {
      filter: { id: new RegExp(CONTENT_MODULE_PREFIX) },
      handler(source) {
        return publicToResolvedId.get(cleanUrl(source));
      },
    },
    load: {
      filter: { id: new RegExp(CONTENT_MODULE_PREFIX) },
      handler(id) {
        const captured = modules.get(cleanUrl(id))?.module;
        if (!captured) return;
        return {
          code: captured.code,
          map: captured.map,
          moduleSideEffects: captured.moduleSideEffects ?? true,
        };
      },
    },
  };
}

export function transformPagesHtml(
  server: ViteDevServer,
  url: string,
  html: string,
  scriptNonce?: string,
): Promise<string> {
  const documentUrl = cleanUrl(url);
  return withDocumentLock(server, documentUrl, () =>
    pagesHtmlTransformContext.run({ documentUrl, scriptNonce, server, transformUrl: url }, () =>
      server.transformIndexHtml(url, html),
    ),
  );
}
