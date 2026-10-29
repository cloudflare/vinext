import type { CachedAppPageValue } from "vinext/shims/cache-handler";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { buildAppPageCacheTags } from "./app-page-cache.js";
import {
  renderAppPageFallbackShell,
  runAppPageStaticGenerationWork,
  type AppPageDispatchRoute,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";
import {
  formatAppPprShellState,
  hasAppPprFallbackShellPrelude,
  markAppPprDynamicFallbackShellHtml,
  parseAppPprShellState,
  splitAppPprFallbackShellState,
  type AppPagePprFallbackCacheShell,
} from "./app-ppr-fallback-shell.js";
import type { GeneratedStaticParamsMemo } from "./app-page-request.js";
import { isrCacheControl, type ISRCacheEntry } from "./isr-cache.js";
import { normalizePregeneratedPathname } from "./pregenerated-concrete-paths.js";
import { encodePrerenderRouteParams } from "./prerender-route-params.js";
import {
  readPrerenderCacheLifeHeader,
  readPrerenderCacheTagsHeader,
  resolveRenderedCacheControl,
} from "./prerender-cache-life-header.js";

/** Next.js's default `expireTime`. */
const DEFAULT_EXPIRE_SECONDS = 31_536_000;

/**
 * The generated params a fallback shell records, as the build does from the
 * params it prerendered: those that agree with the params the shell keeps.
 * Null when they can't be known, so requests ask generateStaticParams, and
 * undefined when a generator failed, so nothing is stored with them.
 */
async function resolveFallbackShellGeneratedParams<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  memo?: GeneratedStaticParamsMemo,
): Promise<Record<string, unknown>[] | null | undefined> {
  const { resolveAppPageGeneratedStaticParamsFor } = await import("./app-page-request.js");
  const keptParamNames = options.route.params.filter(
    (name) => !fallbackShell.fallbackParamNames.includes(name),
  );
  // The encoded values a request's params hold.
  const shellParams =
    encodePrerenderRouteParams(
      options.route.pattern,
      fallbackShell.params,
      fallbackShell.fallbackParamNames,
    )?.params ?? {};
  const keptParams = Object.fromEntries(keptParamNames.map((name) => [name, shellParams[name]]));
  try {
    return await runAppPageStaticGenerationWork(options, () =>
      resolveAppPageGeneratedStaticParamsFor({
        generateStaticParams: options.generateStaticParams,
        params: keptParams,
        paramNames: keptParamNames,
        memo,
      }),
    );
  } catch (paramsError) {
    console.error("[vinext] ISR fallback shell params error:", paramsError);
    return undefined;
  }
}

/**
 * Render a fallback shell a request needs, and store the entry the build would
 * have seeded for it. Returns the entry for the request to use, or null when
 * the shell fails to render.
 *
 * A path's own shell is produced after its page rendered dynamically. A shell
 * that can't be prerendered is stored empty, as its route renders blocking,
 * so later requests don't produce it again.
 */
export async function produceAppPprFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  key: string,
  routeRevalidateSeconds: number | null,
  isConcrete = false,
  // generateStaticParams results the request already has.
  memo?: GeneratedStaticParamsMemo,
): Promise<ISRCacheEntry | null> {
  const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
  // A path's own shell keeps every param, so it records no generated params.
  const generated = isConcrete
    ? null
    : await resolveFallbackShellGeneratedParams(options, fallbackShell, memo);
  // Stored, the shell would keep an incomplete record until it's stale, so a
  // later request produces it once the generators recover.
  if (generated === undefined) {
    options.isrDebug?.("SKIP (fallback shell params error)", fallbackPathname);
    return null;
  }
  const response = await renderAppPageFallbackShell(options, fallbackShell);
  const cacheControlHeader = response.headers.get("cache-control") ?? "";
  const isDynamic = cacheControlHeader.includes("no-store");
  if (!response.ok) {
    await response.body?.cancel();
    options.isrDebug?.("SKIP (failed fallback shell render)", fallbackPathname);
    return null;
  }

  let value: CachedAppPageValue;
  if (isDynamic) {
    // A shell that can't be prerendered is stored empty: its route renders
    // blocking, and later requests neither produce it again nor, with its
    // generated params, ask generateStaticParams.
    await response.body?.cancel();
    value = {
      kind: "APP_PAGE",
      html: markAppPprDynamicFallbackShellHtml(""),
      rscData: undefined,
      headers: undefined,
      postponed:
        generated === null
          ? undefined
          : formatAppPprShellState({
              prelude: false,
              postponed: null,
              resumeDataCache: null,
              generated,
            }),
      status: undefined,
    };
  } else {
    const shell = splitAppPprFallbackShellState(await response.text());
    const linkHeader = response.headers.get("link");
    // An empty shell renders blocking, so it keeps nothing to resume from.
    const state = hasAppPprFallbackShellPrelude(shell.html)
      ? parseAppPprShellState(shell.state ?? undefined)
      : null;
    value = {
      kind: "APP_PAGE",
      html: markAppPprDynamicFallbackShellHtml(shell.html),
      rscData: undefined,
      headers: linkHeader ? { link: linkHeader } : undefined,
      postponed:
        state === null && generated === null
          ? undefined
          : formatAppPprShellState({
              prelude: state?.prelude ?? false,
              postponed: state?.postponed ?? null,
              resumeDataCache: state?.resumeDataCache ?? null,
              generated,
            }),
      status: undefined,
    };
  }

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
  options.isrDebug?.(
    isDynamic
      ? isConcrete
        ? "STORE (empty shell)"
        : "STORE (empty fallback shell)"
      : "STORE (fallback shell)",
    fallbackPathname,
  );

  return {
    value: { lastModified: Date.now(), value, cacheControl },
    isStale: false,
  };
}

/**
 * Store that a fallback shell's kept params weren't generated, unless
 * generateStaticParams now produces them. Its requests render blocking, as
 * Next.js renders a path its prerender manifest has no shell for, and decide
 * so from this entry instead of asking generateStaticParams.
 */
export async function storeAppPprUngeneratedFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  key: string,
  routeRevalidateSeconds: number | null,
  memo?: GeneratedStaticParamsMemo,
): Promise<void> {
  if (!options.isrSetFallbackShell) return;
  const generated = await resolveFallbackShellGeneratedParams(options, fallbackShell, memo);
  if (!generated || generated.length > 0) return;
  const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
  const value: CachedAppPageValue = {
    kind: "APP_PAGE",
    html: markAppPprDynamicFallbackShellHtml(""),
    rscData: undefined,
    headers: undefined,
    postponed: formatAppPprShellState({
      prelude: false,
      postponed: null,
      resumeDataCache: null,
      generated,
    }),
    status: undefined,
  };
  const revalidate =
    routeRevalidateSeconds === null || routeRevalidateSeconds === Infinity
      ? false
      : routeRevalidateSeconds;
  await options.isrSetFallbackShell(key, value, {
    cacheControl: isrCacheControl(revalidate),
    tags: buildAppPageCacheTags(fallbackPathname, []),
  });
  options.isrDebug?.("STORE (ungenerated fallback shell)", fallbackPathname);
}
