import type { CachedAppPageValue } from "vinext/shims/cache-handler";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { buildAppPageCacheTags } from "./app-page-cache.js";
import {
  renderAppPageFallbackShell,
  type AppPageDispatchRoute,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";
import {
  hasAppPprFallbackShellPrelude,
  markAppPprDynamicFallbackShellHtml,
  splitAppPprFallbackShellState,
  type AppPagePprFallbackCacheShell,
} from "./app-ppr-fallback-shell.js";
import { isrCacheControl, type ISRCacheEntry } from "./isr-cache.js";
import { normalizePregeneratedPathname } from "./pregenerated-concrete-paths.js";
import {
  readPrerenderCacheLifeHeader,
  readPrerenderCacheTagsHeader,
  resolveRenderedCacheControl,
} from "./prerender-cache-life-header.js";

/** Next.js's default `expireTime`. */
const DEFAULT_EXPIRE_SECONDS = 31_536_000;

/**
 * Render a fallback shell a request needs, and store the entry the build would
 * have seeded for it. Returns the entry for the request to use, or null when
 * the shell can't be prerendered, as the build would skip it.
 */
export async function produceAppPprFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  key: string,
  routeRevalidateSeconds: number | null,
): Promise<ISRCacheEntry | null> {
  const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
  const response = await renderAppPageFallbackShell(options, fallbackShell);
  const cacheControlHeader = response.headers.get("cache-control") ?? "";
  if (!response.ok || cacheControlHeader.includes("no-store")) {
    await response.body?.cancel();
    options.isrDebug?.("SKIP (dynamic fallback shell render)", fallbackPathname);
    return null;
  }

  const shell = splitAppPprFallbackShellState(await response.text());
  const linkHeader = response.headers.get("link");
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html: markAppPprDynamicFallbackShellHtml(shell.html),
    rscData: undefined,
    headers: linkHeader ? { link: linkHeader } : undefined,
    // An empty shell renders blocking, so it keeps nothing to resume from.
    postponed: shell.state && hasAppPprFallbackShellPrelude(shell.html) ? shell.state : undefined,
    status: undefined,
  };

  // The lifetime and tags build/prerender.ts records for a shell.
  const requestCacheLife = readPrerenderCacheLifeHeader(response.headers);
  const renderedCacheControl = resolveRenderedCacheControl(
    requestCacheLife ?? {},
    cacheControlHeader,
    options.expireSeconds ?? DEFAULT_EXPIRE_SECONDS,
  );
  const routeRevalidate =
    routeRevalidateSeconds === null || routeRevalidateSeconds === Infinity
      ? false
      : routeRevalidateSeconds;
  const revalidate =
    typeof routeRevalidate === "number"
      ? Math.min(routeRevalidate, renderedCacheControl.revalidate ?? routeRevalidate)
      : (renderedCacheControl.revalidate ?? false);
  const cacheControl = isrCacheControl(revalidate, {
    expireSeconds: typeof revalidate === "number" ? renderedCacheControl.expire : undefined,
    staleSeconds: resolveClientStaleTimeSeconds(requestCacheLife),
  });
  const tags = buildAppPageCacheTags(
    fallbackPathname,
    readPrerenderCacheTagsHeader(response.headers),
  );

  if (options.isrSetFallbackShell) {
    const write = options.isrSetFallbackShell(key, value, { cacheControl, tags }).catch((error) => {
      console.error("[vinext] ISR fallback shell cache write error:", error);
    });
    getRequestExecutionContext()?.waitUntil(write);
    // Requests sharing this production find the shell stored once it settles.
    await write;
  }
  options.isrDebug?.("STORE (fallback shell)", fallbackPathname);

  return {
    value: { lastModified: Date.now(), value, cacheControl },
    isStale: false,
  };
}
