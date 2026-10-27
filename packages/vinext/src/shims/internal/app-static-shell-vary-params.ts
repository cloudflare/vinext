/**
 * Static-shell reuse across the params a shell's render didn't read, shared by
 * `<Link>` (`link.tsx`) and `router.prefetch()` (`navigation.ts`). Loaded on
 * demand, as it needs the route manifest's matcher.
 *
 * Ported from Next.js's segment cache (`varyParams`): a prefetched segment is
 * shared by every URL of the route whose values match for the params it read.
 * vinext tracks the params per response, not per segment, so a shell is
 * reused only as a whole.
 */
import { getNavigationRuntime } from "../../client/navigation-runtime.js";
import {
  matchOptimisticRouteManifestRoute,
  resolveOptimisticNavigationParamsForHref,
} from "../../server/app-optimistic-routing.js";
import { stripRscCacheBustingSearchParam } from "../../server/app-rsc-cache-busting.js";
import { stripBasePath } from "../../utils/base-path.js";
import { isUnknownRecord } from "../../utils/record.js";
import type { CachedRscResponse } from "../navigation.js";

/** basePath from next.config.js, injected by the plugin at build time */
const __basePath: string = process.env.__NEXT_ROUTER_BASEPATH ?? "";

type Params = Readonly<Record<string, unknown>>;

type ResolvedHref = {
  params: Params;
  routeId: string;
  routeParamNames: readonly string[];
  search: string;
};

function getSearch(href: string): string {
  const url = new URL(href, "https://vinext.local");
  stripRscCacheBustingSearchParam(url);
  return url.search;
}

function resolveHref(href: string, basePath: string): ResolvedHref | null {
  const routeManifest = getNavigationRuntime()?.bootstrap.routeManifest;
  if (!routeManifest) return null;
  const match = matchOptimisticRouteManifestRoute({ basePath, href, routeManifest });
  if (match === null) return null;
  const params = resolveOptimisticNavigationParamsForHref({ basePath, href, routeManifest });
  if (params === null) return null;
  return {
    params,
    routeId: match.route.id,
    routeParamNames: match.route.paramNames,
    search: getSearch(href),
  };
}

function isSameParamValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

function isSameParams(a: Params, b: Params): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((key) => isSameParamValue(a[key], b[key]))
  );
}

function parseParamsHeader(paramsHeader: string | null): Params | null {
  if (paramsHeader === null) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(paramsHeader));
    return isUnknownRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Create a resolver of the shell another URL's prefetch got, for `targetHref`.
 * It's the target's shell when both URLs match the same route and agree on
 * every param the shell's render read (`?` compares their search strings).
 * The shell must be the source URL's own render, not a rewrite's, with the
 * params the client resolves for it, so the target's params can replace them.
 */
export function createVaryingStaticShellResolver(
  targetHref: string,
): (source: CachedRscResponse, sourceHref: string) => CachedRscResponse | null {
  const target = resolveHref(targetHref, __basePath);
  if (target === null) return () => null;
  const targetPathname = new URL(targetHref, "https://vinext.local").pathname;

  return (source, sourceHref) => {
    if (source.varyParams === undefined || source.renderedPathAndSearch === null) return null;
    const resolvedSource = resolveHref(sourceHref, __basePath);
    if (resolvedSource === null || resolvedSource.routeId !== target.routeId) return null;

    // A rewrite renders another path or query, which the client can't predict.
    const rendered = resolveHref(source.renderedPathAndSearch, "");
    if (
      rendered === null ||
      rendered.routeId !== resolvedSource.routeId ||
      rendered.search !== resolvedSource.search ||
      !isSameParams(rendered.params, resolvedSource.params)
    ) {
      return null;
    }
    const sourceParams = parseParamsHeader(source.paramsHeader);
    if (sourceParams === null || !isSameParams(sourceParams, resolvedSource.params)) return null;

    for (const name of source.varyParams) {
      if (name === "?") {
        if (resolvedSource.search !== target.search) return null;
        continue;
      }
      // A param the client can't resolve can't be compared.
      if (
        !target.routeParamNames.includes(name) &&
        !Object.hasOwn(sourceParams, name) &&
        !Object.hasOwn(target.params, name)
      ) {
        return null;
      }
      if (!isSameParamValue(sourceParams[name], target.params[name])) return null;
    }

    return {
      ...source,
      paramsHeader:
        Object.keys(target.params).length > 0
          ? encodeURIComponent(JSON.stringify(target.params))
          : null,
      renderedPathAndSearch: `${stripBasePath(targetPathname, __basePath)}${target.search}`,
    };
  };
}
