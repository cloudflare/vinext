import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  getPprFallbackShellState,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
} from "vinext/shims/ppr-fallback-shell";
import { _isOnDemandRevalidate, _setResumeDataCacheSeed } from "vinext/shims/cache-request-state";
import { markDynamicUsage } from "vinext/shims/internal/headers-state";
import { createResumeDataCache, parseResumeDataCache } from "vinext/shims/resume-data-cache";
import {
  hasSearchParams,
  runAppPageStaticGenerationWork,
  shouldReadAppPageCache,
  type AppPageDispatchRoute,
  type AppPagePprRuntime,
  type DispatchAppPageOptions,
} from "./app-page-dispatch.js";
import { normalizePregeneratedPathname } from "./pregenerated-concrete-paths.js";
import type { AppPagePprFallbackCacheShell } from "./app-ppr-fallback-shell.js";
import type { ISRCacheEntry } from "./isr-cache.js";

type PprFallbackShellEligibility =
  | {
      kind: "probe-fallback-shells";
      fallbackShells: NonNullable<
        DispatchAppPageOptions<AppPageDispatchRoute>["pprFallbackCacheShells"]
      >;
    }
  | {
      kind:
        | "skip-known-pregenerated-route"
        | "skip-no-fallback-shells"
        | "skip-rsc-request"
        | "skip-non-get"
        | "skip-search-params"
        | "skip-cache-disabled"
        | "skip-on-demand-revalidate";
    };

function classifyPprFallbackShellEligibility<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  currentRevalidateSeconds: number | null,
  isDraftMode: boolean,
  isForceStatic: boolean,
  isForceDynamic: boolean,
): PprFallbackShellEligibility {
  if (options.renderedConcreteUrlPaths?.has(options.cleanPathname) === true) {
    return { kind: "skip-known-pregenerated-route" };
  }

  const fallbackShells = options.pprFallbackCacheShells;
  if (!fallbackShells || fallbackShells.length === 0) {
    return { kind: "skip-no-fallback-shells" };
  }
  if (options.isRscRequest) return { kind: "skip-rsc-request" };
  // Like Next.js, an on-demand revalidation renders the page blocking and
  // stores it instead of resuming a shell with the values it was built with.
  if (_isOnDemandRevalidate()) return { kind: "skip-on-demand-revalidate" };
  if (options.request.method !== "GET") return { kind: "skip-non-get" };
  if (!isForceStatic && hasSearchParams(options.searchParams)) {
    return { kind: "skip-search-params" };
  }
  if (
    !shouldReadAppPageCache({
      isDraftMode,
      isForceDynamic,
      isProgressiveActionRender: options.isProgressiveActionRender === true,
      isProduction: options.isProduction,
      isRscRequest: false,
      revalidateSeconds: currentRevalidateSeconds,
      scriptNonce: options.scriptNonce,
    })
  ) {
    return { kind: "skip-cache-disabled" };
  }

  return { kind: "probe-fallback-shells", fallbackShells };
}

/** What generateStaticParams produces for a request, asked apart from its render. */
async function resolveGeneratedStaticParams<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
) {
  const { resolveAppPageGeneratedStaticParams } = await import("./app-page-request.js");
  return runAppPageStaticGenerationWork(options, () =>
    resolveAppPageGeneratedStaticParams({
      generateStaticParams: options.generateStaticParams,
      params: options.staticParamsValidationParams ?? options.params,
    }),
  );
}

/**
 * The shell a request resumes: the most specific one derived from params
 * generateStaticParams produced, or the route's own shell, which keeps no
 * params. Like Next.js, a path generateStaticParams produced renders blocking
 * and is stored instead. Next.js reads both from its prerender manifest;
 * vinext asks generateStaticParams on a cache miss, as `dynamicParams = false`
 * does, so a deploy without prerendering decides the same way.
 */
async function resolveEligibleFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShells: readonly AppPagePprFallbackCacheShell[],
  generated: Awaited<ReturnType<typeof resolveGeneratedStaticParams>>,
): Promise<AppPagePprFallbackCacheShell | null> {
  const { hasGeneratedStaticParamsFor } = await import("./app-page-request.js");
  const params = options.staticParamsValidationParams ?? options.params;
  if (generated?.isGenerated) return null;
  for (const fallbackShell of fallbackShells) {
    const fallbackParamNames = new Set(fallbackShell.fallbackParamNames);
    const keptParamNames = options.route.params.filter((name) => !fallbackParamNames.has(name));
    if (
      keptParamNames.length === 0 ||
      (generated !== null &&
        hasGeneratedStaticParamsFor(params, generated.staticParams, keptParamNames))
    ) {
      return fallbackShell;
    }
  }
  return null;
}

/**
 * Produce, in the background, the shells of a generated path that aren't
 * stored. The build prerenders these with the path, so a deploy that warms its
 * cache instead fills them when it renders the path.
 */
async function produceMissingFallbackShells<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShells: readonly AppPagePprFallbackCacheShell[],
  currentRevalidateSeconds: number | null,
): Promise<void> {
  // The build prerenders every shell itself.
  if (process.env.VINEXT_PRERENDER === "1") return;
  const { produceAppPprFallbackShell } = await import("./app-ppr-fallback-shell-production.js");
  const { coalesceFallbackShellProduction } = await import("./isr-cache.js");
  for (const fallbackShell of fallbackShells) {
    const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
    const key = options.isrFallbackShellHtmlKey(fallbackPathname);
    (options.scheduleFallbackShellRegeneration ?? options.scheduleBackgroundRegeneration)(
      key,
      async () => {
        const cached = await (options.isrGetFallbackShell ?? options.isrGet)(key);
        if (cached !== null && cached.isExpired !== true) return;
        options.isrDebug?.("RENDER (missing fallback shell)", fallbackPathname);
        await coalesceFallbackShellProduction(key, () =>
          produceAppPprFallbackShell(options, fallbackShell, key, currentRevalidateSeconds),
        );
      },
      { routerKind: "App Router", routePath: options.route.pattern, routeType: "render" },
    );
  }
}

async function serveFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  currentRevalidateSeconds: number | null,
  isForceStatic: boolean,
): Promise<Response | null> {
  const { serveAppPageFallbackShellCacheEntry } = await import("./app-page-cache.js");
  const { rewriteAppPprFallbackShellHtmlNavigation } = await import("./app-ppr-fallback-shell.js");
  const { produceAppPprFallbackShell } = await import("./app-ppr-fallback-shell-production.js");
  const { coalesceFallbackShellProduction } = await import("./isr-cache.js");
  // The build keys a shell by its decoded pathname, like a concrete page.
  const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
  const key = options.isrFallbackShellHtmlKey(fallbackPathname);
  const produce = () =>
    produceAppPprFallbackShell(options, fallbackShell, key, currentRevalidateSeconds);

  let cached: ISRCacheEntry | null;
  try {
    cached = await (options.isrGetFallbackShell ?? options.isrGet)(key);
  } catch (isrReadError) {
    options.isrDebug?.("MISS (fallback shell read error)", fallbackPathname);
    console.error("[vinext] ISR fallback shell cache read error:", isrReadError);
    return null;
  }
  // Like Next.js, a request without a servable shell renders it first, blocking.
  if (cached === null || cached.isExpired === true) {
    options.isrDebug?.(
      cached ? "RENDER (expired fallback shell)" : "RENDER (fallback shell)",
      fallbackPathname,
    );
    try {
      cached = await coalesceFallbackShellProduction(key, produce);
    } catch (renderError) {
      // Like a failed read, a shell that can't be produced leaves the request
      // to the normal render.
      options.isrDebug?.("MISS (fallback shell render error)", fallbackPathname);
      console.error("[vinext] ISR fallback shell render error:", renderError);
      return null;
    }
    if (cached === null) return null;
  }

  return serveAppPageFallbackShellCacheEntry({
    cached,
    clearRequestContext: options.clearRequestContext,
    expireSeconds: options.expireSeconds,
    fallbackPathname,
    isEdgeRuntime: options.isEdgeRuntime,
    isrDebug: options.isrDebug,
    middlewareHeaders: options.middlewareContext.headers,
    middlewareStatus: options.middlewareContext.status,
    revalidateSeconds: currentRevalidateSeconds ?? 0,
    resumeDynamicShell(postponed, hasPrelude) {
      // Like Next.js, a route served from a shell resumes on every request
      // instead of storing the concrete page, while an empty shell's route
      // renders blocking and is stored.
      if (hasPrelude) markDynamicUsage();
      // vinext resumes the shell as a full render whose cached parts come
      // from the values the shell was built with. React's postponed state
      // isn't spliced into the shell's document.
      // A shell whose render read no cached data still resumes, with none.
      const resumeDataCache =
        parseResumeDataCache(postponed) ?? (hasPrelude ? createResumeDataCache() : null);
      _setResumeDataCacheSeed(resumeDataCache);
      return resumeDataCache !== null;
    },
    rewriteHtml(html) {
      return rewriteAppPprFallbackShellHtmlNavigation({
        html,
        isForceStatic,
        params: options.params,
        pathname: options.cleanPathname,
        searchParams: options.searchParams,
      });
    },
    scheduleRegeneration() {
      (options.scheduleFallbackShellRegeneration ?? options.scheduleBackgroundRegeneration)(
        key,
        async () => {
          // A request that finds the shell missing meanwhile joins this render.
          await coalesceFallbackShellProduction(key, produce);
        },
        { routerKind: "App Router", routePath: options.route.pattern, routeType: "render" },
      );
    },
  });
}

export const appPagePprRuntime: AppPagePprRuntime<AppPageDispatchRoute> = {
  beginFinalRender: beginPprFallbackShellFinalRender,
  getState: getPprFallbackShellState,
  run(shell, fn) {
    return runWithPprFallbackShellState(createPprFallbackShellState(shell), fn);
  },
  runSinglePass(shell, fn) {
    const state = createPprFallbackShellState(shell);
    preparePprFallbackShellFinalRender(state);
    return runWithPprFallbackShellState(state, fn);
  },
  async tryServe(options, currentRevalidateSeconds, isDraftMode, isForceStatic, isForceDynamic) {
    const decision = classifyPprFallbackShellEligibility(
      options,
      currentRevalidateSeconds,
      isDraftMode,
      isForceStatic,
      isForceDynamic,
    );
    if (decision.kind !== "probe-fallback-shells") return null;
    let generated: Awaited<ReturnType<typeof resolveGeneratedStaticParams>>;
    try {
      generated = await resolveGeneratedStaticParams(options);
    } catch (paramsError) {
      // The normal render reports a throwing generateStaticParams itself.
      options.isrDebug?.("MISS (fallback shell params error)", options.cleanPathname);
      console.error("[vinext] ISR fallback shell params error:", paramsError);
      return null;
    }
    if (generated?.isGenerated) {
      await produceMissingFallbackShells(
        options,
        decision.fallbackShells,
        currentRevalidateSeconds,
      );
      return null;
    }
    const fallbackShell = await resolveEligibleFallbackShell(
      options,
      decision.fallbackShells,
      generated,
    );
    return fallbackShell
      ? serveFallbackShell(options, fallbackShell, currentRevalidateSeconds, isForceStatic)
      : null;
  },
  async produceMissingShells(options, currentRevalidateSeconds) {
    const fallbackShells = options.pprFallbackCacheShells;
    if (!fallbackShells || fallbackShells.length === 0) return;
    const generated = await resolveGeneratedStaticParams(options);
    if (generated?.isGenerated) {
      await produceMissingFallbackShells(options, fallbackShells, currentRevalidateSeconds);
    }
  },
  async warm(options) {
    const { warmPprFallbackShellCaches } = await import("./app-ppr-fallback-shell-render.js");
    await warmPprFallbackShellCaches(options);
  },
};

export { createAppPprRequestFallbackShells } from "./app-ppr-fallback-shell.js";
