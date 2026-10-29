import {
  beginPprFallbackShellFinalRender,
  createPprFallbackShellState,
  getPprFallbackShellState,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
} from "vinext/shims/ppr-fallback-shell";
import {
  _getResumeDataCacheSeed,
  _isOnDemandRevalidate,
  _setResumeDataCacheSeed,
} from "vinext/shims/cache-request-state";
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
import { encodePrerenderRouteParams } from "./prerender-route-params.js";
import {
  createAppPprRequestConcreteShell,
  type AppPagePprFallbackCacheShell,
} from "./app-ppr-fallback-shell.js";
import type { AppPageRouteParamNames, GeneratedStaticParamsMemo } from "./app-page-request.js";
import type { AppPagePprShellResume } from "./app-page-stream.js";
import type { ISRCacheEntry } from "./isr-cache.js";

type PprFallbackShellEligibility =
  | {
      kind: "probe-shells";
      fallbackShells: NonNullable<
        DispatchAppPageOptions<AppPageDispatchRoute>["pprFallbackCacheShells"]
      >;
    }
  | {
      kind:
        | "skip-known-pregenerated-route"
        | "skip-fallback-shell-render"
        | "seed-rsc-request"
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

  // A shell's own render is a fresh prerender, never a resume of the shell.
  if (options.pprFallbackShell) return { kind: "skip-fallback-shell-render" };
  // Like Next.js, an on-demand revalidation renders the page blocking and
  // stores it instead of resuming a shell with the values it was built with.
  if (_isOnDemandRevalidate()) return { kind: "skip-on-demand-revalidate" };
  if (options.request.method !== "GET") return { kind: "skip-non-get" };
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
  if (options.isRscRequest) return { kind: "seed-rsc-request" };
  if (!isForceStatic && hasSearchParams(options.searchParams)) {
    return { kind: "skip-search-params" };
  }

  return { kind: "probe-shells", fallbackShells: options.pprFallbackCacheShells ?? [] };
}

/** What generateStaticParams produces for a request, asked apart from its render. */
async function resolveGeneratedStaticParams<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  memo: GeneratedStaticParamsMemo,
) {
  const { resolveAppPageGeneratedStaticParams } = await import("./app-page-request.js");
  return runAppPageStaticGenerationWork(options, () =>
    resolveAppPageGeneratedStaticParams({
      generateStaticParams: options.generateStaticParams,
      params: options.staticParamsValidationParams ?? options.params,
      memo,
      routeParamNames: routeParamNamesOf(options.route),
    }),
  );
}

/**
 * The fallback shell a request resumes: the most specific one derived from
 * params generateStaticParams produced, or the route's shell that keeps no
 * params. Like Next.js, a path generateStaticParams produced renders blocking
 * and is stored instead. Next.js reads both from its prerender manifest;
 * without a stored shell recording them, vinext asks generateStaticParams, as
 * `dynamicParams = false` does, so a deploy without prerendering decides the
 * same way.
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
    const keptParamNames = keptParamNamesOf(options.route, fallbackShell);
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
  memo?: GeneratedStaticParamsMemo,
  regeneratesStale = false,
): Promise<void> {
  // The build prerenders every shell itself.
  if (process.env.VINEXT_PRERENDER === "1") return;
  for (const fallbackShell of fallbackShells) {
    scheduleShellProduction(
      options,
      fallbackShell,
      currentRevalidateSeconds,
      false,
      regeneratesStale,
      memo,
    );
  }
}

/** Produce a shell in the background unless it's stored, or regenerate a stale one. */
function scheduleShellProduction<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  shell: AppPagePprFallbackCacheShell,
  currentRevalidateSeconds: number | null,
  isConcrete: boolean,
  isStaleRegeneration = false,
  // generateStaticParams results the request already has.
  memo?: GeneratedStaticParamsMemo,
): void {
  const pathname = normalizePregeneratedPathname(shell.pathname);
  const key = options.isrFallbackShellHtmlKey(pathname);
  (options.scheduleFallbackShellRegeneration ?? options.scheduleBackgroundRegeneration)(
    key,
    async () => {
      const cached = await (options.isrGetFallbackShell ?? options.isrGet)(key);
      if (
        cached !== null &&
        cached.isExpired !== true &&
        !(isStaleRegeneration && cached.isStale)
      ) {
        return;
      }
      const { produceAppPprFallbackShell } = await import("./app-ppr-fallback-shell-production.js");
      const { coalesceFallbackShellProduction } = await import("./isr-cache.js");
      options.isrDebug?.(
        isConcrete ? "RENDER (missing shell)" : "RENDER (missing fallback shell)",
        pathname,
      );
      await coalesceFallbackShellProduction(key, () =>
        produceAppPprFallbackShell(options, shell, key, currentRevalidateSeconds, isConcrete, memo),
      );
    },
    { routerKind: "App Router", routePath: options.route.pattern, routeType: "render" },
  );
}

/**
 * Like Next.js, an RSC request for a path with its own shell reads the values
 * the shell was built with, so its payload agrees with the shell's HTML. A
 * stale shell regenerates after it.
 */
async function seedRscRequestFromOwnShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  currentRevalidateSeconds: number | null,
): Promise<void> {
  const concreteShell = createAppPprRequestConcreteShell(options.route, options.params);
  if (!concreteShell) return;
  const read = await readShell(options, concreteShell);
  if (!read.ok || read.cached === null || read.cached.isExpired === true) return;
  const value = read.cached.value.value;
  if (value?.kind !== "APP_PAGE") return;
  // A shell that read no cached data has none to seed, but still regenerates.
  if (read.cached.isStale) {
    scheduleShellProduction(options, concreteShell, currentRevalidateSeconds, true, true);
  }
  const { parseAppPprShellState } = await import("./app-ppr-fallback-shell.js");
  const resumeDataCache = parseResumeDataCache(
    parseAppPprShellState(value.postponed)?.resumeDataCache ?? undefined,
  );
  if (resumeDataCache !== null) _setResumeDataCacheSeed(resumeDataCache);
}

/** A concrete shell that isn't stored, or is expired. */
const SHELL_MISSING = Symbol("vinext.pprShellMissing");

type ShellRead = { ok: true; cached: ISRCacheEntry | null } | { ok: false };

async function readShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  shell: AppPagePprFallbackCacheShell,
): Promise<ShellRead> {
  const pathname = normalizePregeneratedPathname(shell.pathname);
  try {
    return {
      ok: true,
      cached: await (options.isrGetFallbackShell ?? options.isrGet)(
        options.isrFallbackShellHtmlKey(pathname),
      ),
    };
  } catch (isrReadError) {
    options.isrDebug?.("MISS (fallback shell read error)", pathname);
    console.error("[vinext] ISR fallback shell cache read error:", isrReadError);
    return { ok: false };
  }
}

async function serveFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShell: AppPagePprFallbackCacheShell,
  currentRevalidateSeconds: number | null,
  isForceStatic: boolean,
  isConcrete = false,
  read?: ShellRead,
  memo?: GeneratedStaticParamsMemo,
): Promise<Response | AppPagePprShellResume | null | typeof SHELL_MISSING> {
  const { serveAppPageFallbackShellCacheEntry } = await import("./app-page-cache.js");
  const {
    parseAppPprShellState,
    replaceAppPprShellFallbackParamKeys,
    rewriteAppPprFallbackShellHtmlNavigation,
    stripAppPprDynamicFallbackShellMarker,
  } = await import("./app-ppr-fallback-shell.js");
  const { produceAppPprFallbackShell } = await import("./app-ppr-fallback-shell-production.js");
  const { coalesceFallbackShellProduction } = await import("./isr-cache.js");
  // The build keys a shell by its decoded pathname, like a concrete page.
  const fallbackPathname = normalizePregeneratedPathname(fallbackShell.pathname);
  const key = options.isrFallbackShellHtmlKey(fallbackPathname);
  const produce = () =>
    produceAppPprFallbackShell(
      options,
      fallbackShell,
      key,
      currentRevalidateSeconds,
      isConcrete,
      memo,
    );
  // The encoded params the shell rendered with, as its segment keys hold them.
  const shellParams =
    encodePrerenderRouteParams(
      options.route.pattern,
      fallbackShell.params,
      fallbackShell.fallbackParamNames,
    )?.params ?? {};
  const rewriteHtml = (html: string) =>
    rewriteAppPprFallbackShellHtmlNavigation({
      html,
      isForceStatic,
      params: options.params,
      pathname: options.cleanPathname,
      searchParams: options.searchParams,
    });

  const shellRead = read ?? (await readShell(options, fallbackShell));
  if (!shellRead.ok) return null;
  let cached = shellRead.cached;
  // A request without its path's shell renders the page, and the shell is
  // produced after it.
  if (isConcrete && (cached === null || cached.isExpired === true)) return SHELL_MISSING;
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
    resumeDynamicShell(value, hasPrelude) {
      // Like Next.js, a route served from a shell resumes on every request
      // instead of storing the concrete page, while an empty shell's route
      // renders blocking and is stored.
      if (hasPrelude) markDynamicUsage();
      const state = hasPrelude ? parseAppPprShellState(value.postponed) : null;
      // The request's render reads the values the shell was built with, so
      // its holes fit the shell. A shell whose render read no cached data
      // still resumes, with none.
      const resumeDataCache =
        parseResumeDataCache(state?.resumeDataCache ?? undefined) ??
        (hasPrelude ? createResumeDataCache() : null);
      _setResumeDataCacheSeed(resumeDataCache);
      // Like Next.js, a prelude is sent as it was stored, and only its holes
      // render. A whole document is rendered again around them instead.
      const linkHeader = value.headers?.link;
      return {
        isResumed: resumeDataCache !== null,
        resume: state?.prelude
          ? {
              prelude: rewriteHtml(stripAppPprDynamicFallbackShellMarker(value.html)),
              postponed: replaceAppPprShellFallbackParamKeys(
                state.postponed,
                fallbackShell.fallbackParamNames.map((name) => ({
                  name,
                  shellValue: shellParams[name],
                  requestValue: options.params[name],
                })),
              ),
              linkHeader: typeof linkHeader === "string" ? linkHeader : undefined,
            }
          : null,
      };
    },
    rewriteHtml,
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

/** A request no stored fallback shell decides for. */
const UNDECIDED = Symbol("vinext.pprShellUndecided");

function routeParamNamesOf(route: AppPageDispatchRoute): AppPageRouteParamNames {
  return {
    optionalCatchAllParamNames: route.pattern
      .split("/")
      .filter((part) => part.startsWith(":") && part.endsWith("*"))
      .map((part) => part.slice(1, -1)),
    paramNames: route.params,
  };
}

function keptParamNamesOf(
  route: AppPageDispatchRoute,
  fallbackShell: AppPagePprFallbackCacheShell,
): string[] {
  return route.params.filter((name) => !fallbackShell.fallbackParamNames.includes(name));
}

/**
 * Like Next.js reading its prerender manifest, a request that finds a stored
 * fallback shell decides from the generated params the shell records, without
 * asking generateStaticParams. A stored shell's kept params were generated, so
 * the request resumes it, or a more specific shell those params show it may
 * use, unless they show its own path was generated.
 */
async function serveStoredFallbackShell<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShells: readonly AppPagePprFallbackCacheShell[],
  currentRevalidateSeconds: number | null,
  isForceStatic: boolean,
  /** The reads it made, which an undecided request reuses. */
  reads: Map<AppPagePprFallbackCacheShell, ShellRead>,
): Promise<Response | AppPagePprShellResume | null | typeof UNDECIDED> {
  const { hasGeneratedStaticParamsFor, isAppPageParamsGenerated } =
    await import("./app-page-request.js");
  const { parseAppPprShellState } = await import("./app-ppr-fallback-shell.js");
  const params = options.staticParamsValidationParams ?? options.params;
  let isUndecided = false;
  for (const [index, fallbackShell] of fallbackShells.entries()) {
    const read = await readShell(options, fallbackShell);
    if (!read.ok) return null;
    reads.set(fallbackShell, read);
    const value = read.cached?.value.value;
    if (value?.kind !== "APP_PAGE") {
      isUndecided = true;
      continue;
    }
    // An expired shell's record isn't trusted, like the shell itself.
    if (read.cached!.isExpired === true) return UNDECIDED;
    const generated = parseAppPprShellState(value.postponed)?.generated ?? null;
    if (generated === null) return UNDECIDED;
    if (isAppPageParamsGenerated(params, generated, routeParamNamesOf(options.route))) {
      // The request doesn't serve the shell, so a stale one regenerates here.
      if (read.cached!.isStale) {
        scheduleShellProduction(options, fallbackShell, currentRevalidateSeconds, false, true);
      }
      await produceMissingFallbackShells(options, fallbackShells, currentRevalidateSeconds);
      return null;
    }
    const isEligible = (shell: AppPagePprFallbackCacheShell) => {
      const keptParamNames = keptParamNamesOf(options.route, shell);
      return (
        keptParamNames.length === 0 ||
        hasGeneratedStaticParamsFor(params, generated, keptParamNames)
      );
    };
    if (!isEligible(fallbackShell)) {
      // The shell records that its kept params weren't generated, nor were a
      // more specific shell's, so the request is left to a less specific one.
      // Once stale, it's asked again.
      isUndecided = read.cached!.isStale;
      continue;
    }
    const moreSpecificShell = fallbackShells.slice(0, index).find(isEligible);
    const served = moreSpecificShell
      ? await serveFallbackShell(
          options,
          moreSpecificShell,
          currentRevalidateSeconds,
          isForceStatic,
        )
      : await serveFallbackShell(
          options,
          fallbackShell,
          currentRevalidateSeconds,
          isForceStatic,
          false,
          read,
        );
    return served === SHELL_MISSING ? null : served;
  }
  return isUndecided ? UNDECIDED : null;
}

/**
 * Record, in the background, that a request's fallback shells keep params
 * generateStaticParams didn't produce, as a path with a root param it didn't
 * generate, so later requests render blocking without asking it.
 */
function storeUngeneratedFallbackShells<TRoute extends AppPageDispatchRoute>(
  options: DispatchAppPageOptions<TRoute>,
  fallbackShells: readonly AppPagePprFallbackCacheShell[],
  currentRevalidateSeconds: number | null,
  memo: GeneratedStaticParamsMemo,
): void {
  if (process.env.VINEXT_PRERENDER === "1") return;
  for (const fallbackShell of fallbackShells) {
    const key = options.isrFallbackShellHtmlKey(
      normalizePregeneratedPathname(fallbackShell.pathname),
    );
    (options.scheduleFallbackShellRegeneration ?? options.scheduleBackgroundRegeneration)(
      key,
      async () => {
        const { storeAppPprUngeneratedFallbackShell } =
          await import("./app-ppr-fallback-shell-production.js");
        await storeAppPprUngeneratedFallbackShell(
          options,
          fallbackShell,
          key,
          currentRevalidateSeconds,
          memo,
        );
      },
      { routerKind: "App Router", routePath: options.route.pattern, routeType: "render" },
    );
  }
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
    if (decision.kind === "seed-rsc-request") {
      await seedRscRequestFromOwnShell(options, currentRevalidateSeconds);
      return null;
    }
    if (decision.kind !== "probe-shells") return null;
    // Like Next.js, a path with its own shell resumes it: a path
    // generateStaticParams produced, a route without fallback params, or a
    // path rendered once before. Its shell keeps every param.
    const concreteShell = createAppPprRequestConcreteShell(options.route, options.params);
    if (concreteShell) {
      const served = await serveFallbackShell(
        options,
        concreteShell,
        currentRevalidateSeconds,
        isForceStatic,
        true,
      );
      if (served !== SHELL_MISSING) return served;
    }
    if (decision.fallbackShells.length === 0) return null;
    const reads = new Map<AppPagePprFallbackCacheShell, ShellRead>();
    const stored = await serveStoredFallbackShell(
      options,
      decision.fallbackShells,
      currentRevalidateSeconds,
      isForceStatic,
      reads,
    );
    if (stored !== UNDECIDED) return stored;
    // Producing or recording the request's shells reuses what generateStaticParams
    // returned here, so each generator runs once per parent.
    const memo: GeneratedStaticParamsMemo = new Map();
    let generated: Awaited<ReturnType<typeof resolveGeneratedStaticParams>>;
    try {
      generated = await resolveGeneratedStaticParams(options, memo);
    } catch (paramsError) {
      // The normal render reports a throwing generateStaticParams itself.
      options.isrDebug?.("MISS (fallback shell params error)", options.cleanPathname);
      console.error("[vinext] ISR fallback shell params error:", paramsError);
      return null;
    }
    if (generated?.isGenerated) {
      // A stale shell's record left the request undecided, as one recording
      // that the request's params weren't generated, so it regenerates.
      await produceMissingFallbackShells(
        options,
        decision.fallbackShells,
        currentRevalidateSeconds,
        memo,
        true,
      );
      return null;
    }
    // Another request may have stored the path's own shell meanwhile.
    if (concreteShell) {
      const served = await serveFallbackShell(
        options,
        concreteShell,
        currentRevalidateSeconds,
        isForceStatic,
        true,
      );
      if (served !== SHELL_MISSING) return served;
    }
    const fallbackShell = await resolveEligibleFallbackShell(
      options,
      decision.fallbackShells,
      generated,
    );
    if (!fallbackShell) {
      storeUngeneratedFallbackShells(
        options,
        decision.fallbackShells,
        currentRevalidateSeconds,
        memo,
      );
      return null;
    }
    // A shell that wasn't servable is read again, as another request may have
    // stored it while this one asked generateStaticParams.
    const read = reads.get(fallbackShell);
    const served = await serveFallbackShell(
      options,
      fallbackShell,
      currentRevalidateSeconds,
      isForceStatic,
      false,
      read?.ok && read.cached !== null && read.cached.isExpired !== true ? read : undefined,
      memo,
    );
    return served === SHELL_MISSING ? null : served;
  },
  produceConcreteShell(
    options,
    currentRevalidateSeconds,
    isDraftMode,
    isForceStatic,
    isForceDynamic,
  ) {
    // A shell's own render, the build, which prerenders the path, and a
    // request that resumed a shell don't.
    if (
      options.pprFallbackShell ||
      process.env.VINEXT_PRERENDER === "1" ||
      _getResumeDataCacheSeed() !== null
    ) {
      return;
    }
    const decision = classifyPprFallbackShellEligibility(
      options,
      currentRevalidateSeconds,
      isDraftMode,
      isForceStatic,
      isForceDynamic,
    );
    if (decision.kind !== "probe-shells") return;
    const concreteShell = createAppPprRequestConcreteShell(options.route, options.params);
    if (concreteShell) {
      scheduleShellProduction(options, concreteShell, currentRevalidateSeconds, true);
    }
  },
  async produceMissingShells(options, currentRevalidateSeconds) {
    const fallbackShells = options.pprFallbackCacheShells;
    if (!fallbackShells || fallbackShells.length === 0) return;
    const memo: GeneratedStaticParamsMemo = new Map();
    const generated = await resolveGeneratedStaticParams(options, memo);
    if (generated?.isGenerated) {
      await produceMissingFallbackShells(options, fallbackShells, currentRevalidateSeconds, memo);
    }
  },
  async warm(options) {
    const { warmPprFallbackShellCaches } = await import("./app-ppr-fallback-shell-render.js");
    await warmPprFallbackShellCaches(options);
  },
};

export { createAppPprRequestFallbackShells } from "./app-ppr-fallback-shell.js";
