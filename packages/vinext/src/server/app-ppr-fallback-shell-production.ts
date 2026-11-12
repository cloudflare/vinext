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
  isAppPprStoredPage,
  markAppPprDynamicFallbackShellHtml,
  parseAppPprShellState,
  splitAppPprFallbackShellState,
  type AppPagePprFallbackCacheShell,
} from "./app-ppr-fallback-shell.js";
import type { GeneratedStaticParamsMemo } from "./app-page-request.js";
import { isrCacheControl, type AppPageShellPart, type ISRCacheEntry } from "./isr-cache.js";
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
  // The values the shell was built with, which an RSC request reads too.
  let resumeDataCache: string | null = null;
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
    resumeDataCache = state?.resumeDataCache ?? null;
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

  // vinext stores a page's document and RSC payload apart, where Next.js keeps
  // them in one entry with the shell's state. So where a page read finds the
  // shell, a path's own shell is stored beside the page's RSC payload too,
  // holding the values the shell was built with, which an RSC request reads.
  const rscKey =
    isConcrete && options.isrPageReadsFindOwnShells === true
      ? options.isrRscKey(options.cleanPathname, null)
      : null;
  const writes: ShellWrite[] = [[key, value, isConcrete ? "document" : undefined]];
  if (rscKey !== null) {
    writes.push([
      rscKey,
      {
        kind: "APP_PAGE",
        html: markAppPprDynamicFallbackShellHtml(""),
        rscData: undefined,
        headers: undefined,
        postponed:
          resumeDataCache === null
            ? undefined
            : formatAppPprShellState({
                prelude: false,
                postponed: null,
                resumeDataCache,
                generated: null,
              }),
        status: undefined,
      },
      "rsc",
    ]);
  }

  // A path's own shell shares its page's keys, so a page another request
  // stored under one of them while the shell rendered is kept. A page under
  // its document key means the path has no shell, so neither part is stored.
  const unstored = isConcrete ? await withoutStoredPages(options, writes) : writes;
  if (unstored[0]?.[0] !== key) {
    options.isrDebug?.("SKIP (page stored under the shell's key)", fallbackPathname);
    return null;
  }
  const { isrSetFallbackShell } = options;
  if (isrSetFallbackShell) {
    const write = ([writeKey, writeValue, part]: ShellWrite) =>
      isrSetFallbackShell(writeKey, writeValue, { cacheControl, tags }, part);
    const [document, ...parts] = unstored;
    // An RSC request trusts the shell's RSC part, so it's stored only once
    // the document is, which the next dynamic render can produce again.
    const stored = write(document!).then(
      () =>
        Promise.all(
          parts.map((part) =>
            write(part).catch((error) => {
              console.error("[vinext] ISR fallback shell cache write error:", error);
            }),
          ),
        ),
      (error) => {
        console.error("[vinext] ISR fallback shell cache write error:", error);
      },
    );
    getRequestExecutionContext()?.waitUntil(stored);
    // Requests sharing this production find the shell stored once it settles.
    await stored;
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

/** A shell's key and value, and the page part a path's own shell is stored under. */
type ShellWrite = [key: string, value: CachedAppPageValue, part?: AppPageShellPart];

/** The writes whose key holds no stored page. */
async function withoutStoredPages<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  writes: readonly ShellWrite[],
): Promise<ShellWrite[]> {
  const stored = await Promise.all(
    writes.map(async ([key, , part]) => {
      try {
        return isAppPprStoredPage(
          await (options.isrGetFallbackShell
            ? options.isrGetFallbackShell(key, part)
            : options.isrGet(key)),
        );
      } catch (isrReadError) {
        // A page may be stored there, so that part isn't written. A later
        // dynamic render produces it again.
        console.error("[vinext] ISR fallback shell cache read error:", isrReadError);
        return true;
      }
    }),
  );
  return writes.filter((_write, index) => !stored[index]);
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
