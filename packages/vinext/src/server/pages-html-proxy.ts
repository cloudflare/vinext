import type { Plugin, ViteDevServer } from "vite";
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

const HTML_PROXY_SCRIPT_RE =
  /<script\b[^>]*\bsrc="([^"]*[?&]html-proxy&index=(\d+)\.js)"[^>]*><\/script>/g;
const CONTENT_MODULE_PREFIX = "__vinext_html_proxy_content_";
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

/** Capture Vite's exact proxy sources and rewrite them to immutable modules. */
export function createPagesHtmlProxyCapturePlugin(): Plugin {
  const modules = new Map<string, CapturedProxyModule>();
  const publicToResolvedId = new Map<string, string>();
  return {
    name: "vinext:pages-html-proxy-capture",
    enforce: "pre",
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
        });
        const hash = createHash("sha256").update(identity).digest("hex");
        const publicUrl = contentModuleUrl(active.documentUrl, hash, index, publicBase);
        const resolvedId = contentModuleId(server.config.root, publicUrl, publicBase);
        modules.set(resolvedId, loaded);
        publicToResolvedId.set(cleanUrl(publicUrl), resolvedId);
        publicToResolvedId.set(cleanUrl(stripBase(publicUrl, publicBase)), resolvedId);
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
    resolveId: {
      filter: { id: new RegExp(CONTENT_MODULE_PREFIX) },
      handler(source) {
        return publicToResolvedId.get(cleanUrl(source));
      },
    },
    load: {
      filter: { id: new RegExp(CONTENT_MODULE_PREFIX) },
      handler(id) {
        const captured = modules.get(cleanUrl(id));
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
