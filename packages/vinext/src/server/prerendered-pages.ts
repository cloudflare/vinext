/**
 * Prerendered Pages Router output as cache entries.
 *
 * `next start` serves a prerendered page from `.next/server/pages/<route>.html`
 * from the first request: its FileSystemCache reads the file on a memory cache
 * miss and dates the entry with the file's mtime, so `revalidate` counts from
 * the build (server/lib/incremental-cache/file-system-cache.ts). The Node
 * production server does the same with `dist/server/prerendered-routes`, and
 * the Cloudflare Static Assets adapter packages the same entries at build time.
 */

import fs from "node:fs";
import path from "pathslash";
import { extractVinextNextDataJson } from "../client/vinext-next-data.js";
import {
  setPrerenderedPagesReader,
  type CacheControlMetadata,
  type CachedPagesValue,
  type CachedRedirectValue,
} from "vinext/shims/cache-handler";
import { getOutputPath } from "../utils/prerender-output-paths.js";
import { pagesIsrCacheKey } from "./isr-cache.js";
import { readPrerenderManifest, type PrerenderManifestRoute } from "./prerender-manifest.js";

/** The Pages ISR key a prerendered URL is served under, as the request handler builds it. */
export function prerenderedPagesCacheKey(
  pathname: string,
  locale: string | undefined,
  buildId: string,
): string {
  // Strip the explicit prerender locale, just as the request handler does.
  let pagesPathname = new URL(`https://vinext.invalid${pathname}`).pathname;
  if (locale) {
    const prefix = `/${locale}`;
    if (pagesPathname === prefix) pagesPathname = "/";
    else if (pagesPathname.startsWith(`${prefix}/`))
      pagesPathname = pagesPathname.slice(prefix.length);
  }
  return pagesIsrCacheKey(pagesPathname, buildId, locale ? `locale:${locale}` : undefined);
}

/** The cache policy a prerendered route was rendered with, when it reported one. */
export function prerenderedCacheControl(
  route: PrerenderManifestRoute,
): CacheControlMetadata | undefined {
  if (route.revalidate === undefined) return undefined;
  return {
    revalidate: route.revalidate,
    ...(route.expire === undefined ? {} : { expire: route.expire }),
    ...(route.stale === undefined ? {} : { stale: route.stale }),
  };
}

export type PrerenderedPagesValue = {
  /** The locale the page was rendered for, which its cache key is built from. */
  locale: string | undefined;
  /** `null` is a getStaticProps `notFound` snapshot. */
  value: CachedPagesValue | CachedRedirectValue | null;
};

/**
 * The cache value a rendered Pages manifest route stores, read from its
 * prerendered HTML. Returns `undefined` when the page must keep rendering at
 * request time.
 */
export function readPrerenderedPagesValue(
  route: PrerenderManifestRoute,
  html: string,
): PrerenderedPagesValue | undefined {
  if (route.notFound) return { locale: route.locale, value: null };
  if (route.redirectProps) {
    return { locale: route.locale, value: { kind: "REDIRECT", props: route.redirectProps } };
  }
  const json = extractVinextNextDataJson(html);
  // Only GSP terminal results receive manifest metadata above. Redirects
  // produced before page rendering must keep running at request time.
  if (json === null) return undefined;
  const nextData = JSON.parse(json) as {
    props?: object;
    gsp?: boolean;
    autoExport?: boolean;
    locale?: string;
  };
  // Do not freeze getInitialProps/SSR pages that a source-only prerender
  // classification may have admitted (for example, custom _app props).
  if (nextData.gsp !== true && nextData.autoExport !== true) return undefined;
  if (!nextData.props || typeof nextData.props !== "object") {
    throw new Error(`[vinext] Missing prerendered Pages props for ${route.path ?? route.route}`);
  }
  return {
    locale: nextData.locale ?? route.locale,
    value: {
      kind: "PAGES",
      html,
      pageData: nextData.props,
      headers: route.headers,
      status:
        route.route === "/404" ? 404 : route.route === "/500" ? 500 : (route.responseStatus ?? 200),
    },
  };
}

/**
 * Let the memory cache read prerendered Pages routes from `prerendered-routes`
 * on a miss. Only the manifest is read here; each page is read on its first
 * lookup, so a large build costs nothing at startup and an evicted entry is
 * simply read again.
 *
 * `null` removes the reader, for a server that must render every page.
 *
 * @returns The number of prerendered Pages entries that can be read.
 */
export function installPrerenderedPagesReader(serverDir: string | null): number {
  const files = new Map<string, { file: string; route: PrerenderManifestRoute }>();
  const manifest = serverDir
    ? readPrerenderManifest(path.join(serverDir, "vinext-prerender.json"))
    : null;
  if (serverDir && manifest?.buildId && Array.isArray(manifest.routes)) {
    const prerenderDir = path.join(serverDir, "prerendered-routes");
    for (const route of manifest.routes) {
      if (route.status !== "rendered" || route.router !== "pages") continue;
      if (typeof route.revalidate === "number" && route.revalidate <= 0) continue;
      const pathname = route.path ?? route.route;
      files.set(prerenderedPagesCacheKey(pathname, route.locale, manifest.buildId), {
        file: path.join(prerenderDir, getOutputPath(pathname, manifest.trailingSlash ?? false)),
        route,
      });
    }
  }

  setPrerenderedPagesReader(
    files.size === 0
      ? undefined
      : (key) => {
          const entry = files.get(key);
          if (!entry) return null;
          return (async () => {
            try {
              const [html, stat] = await Promise.all([
                fs.promises.readFile(entry.file, "utf-8"),
                fs.promises.stat(entry.file),
              ]);
              const prerendered = readPrerenderedPagesValue(entry.route, html);
              // A page rendered for another locale than its manifest entry
              // names belongs under another key.
              if (!prerendered || prerendered.locale !== entry.route.locale) return null;
              return {
                value: prerendered.value,
                cacheControl: prerenderedCacheControl(entry.route),
                lastModified: stat.mtimeMs,
              };
            } catch (error) {
              console.warn(`[vinext] Failed to read prerendered page ${entry.file}:`, error);
              return null;
            }
          })();
        },
  );
  return files.size;
}
