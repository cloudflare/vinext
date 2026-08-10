import {
  isValidMetadataImageId,
  manifestToJson,
  matchMetadataRoutePattern,
  robotsToText,
  sitemapToXml,
  type ManifestConfig,
  type MetadataFileRoute,
  type RobotsConfig,
  type SitemapEntry,
} from "./metadata-routes.js";
import { notFoundResponse } from "./http-error-responses.js";
import {
  closeAfterResponse,
  createRequestContext,
  markFullyBufferedBody,
  runWithRequestContext,
} from "vinext/shims/unified-request-context";
import { isrCacheControl, type ISRCacheEntry, type IsrWritePolicy } from "./isr-cache.js";
import {
  buildAppRouteCacheValue,
  buildRouteHandlerCachedResponse,
} from "./app-route-handler-response.js";
import {
  _consumeRequestScopedCacheLife,
  cacheLifeProfiles,
  type CacheLifeConfig,
} from "vinext/shims/cache-request-state";
import {
  applyPrerenderCacheLifeHeader,
  applyPrerenderCacheTagsHeader,
} from "./prerender-cache-life-header.js";
import {
  ensureFetchPatch,
  getCollectedFetchTags,
  setCurrentFetchSoftTags,
} from "vinext/shims/fetch-cache";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import type { CachedRouteValue } from "vinext/shims/cache-handler";
import { buildPageCacheTags } from "./implicit-tags.js";
import { resolveClientStaleTimeSeconds } from "../utils/cache-control-metadata.js";
import { VINEXT_METADATA_ROUTE_CACHE_HEADER } from "./headers.js";
import { isMetadataResponseCacheable } from "./metadata-route-cache-policy.js";

type AppPageParams = Record<string, string | string[]>;
type MetadataRouteFunction = (props: Record<string, unknown>) => unknown;
type MetadataRouteMakeThenableParams = (params: AppPageParams) => unknown;
type MetadataRouteCacheGetter = (key: string) => Promise<ISRCacheEntry | null>;
type MetadataRouteCacheSetter = (
  key: string,
  data: CachedRouteValue,
  policy: IsrWritePolicy,
) => Promise<void>;
type MetadataRouteBackgroundRegenerator = (
  key: string,
  renderFn: () => Promise<void>,
  errorContext?: {
    routerKind: "App Router";
    routePath: string;
    routeType: "route";
  },
) => void;

export type MetadataRuntimeRoute = MetadataFileRoute & {
  fileDataBase64?: string;
};

type MetadataRouteRequestOptions = {
  metadataRoutes: readonly MetadataRuntimeRoute[];
  cleanPathname: string;
  isrGet?: MetadataRouteCacheGetter;
  isrRouteKey?: (pathname: string) => string;
  isrSet?: MetadataRouteCacheSetter;
  makeThenableParams: MetadataRouteMakeThenableParams;
  scheduleBackgroundRegeneration?: MetadataRouteBackgroundRegenerator;
};

type MatchedMetadataRoute = {
  params: AppPageParams | null;
  imageId: string | null;
};

type MetadataRouteFunctions = {
  defaultExport: MetadataRouteFunction | null;
  generateImageMetadata: MetadataRouteFunction | null;
  generateSitemaps: MetadataRouteFunction | null;
  hasGeneratedImageMetadata: boolean;
};

export type PrerenderableMetadataRoute = {
  path: string;
  routePattern: string;
  routeSegments: string[];
};

type RenderedMetadataRoute = {
  cacheLife: CacheLifeConfig | null;
  collectedTags: string[];
  response: Response;
};

function isOuterMetadataCacheEnabled(): boolean {
  return process.env.NODE_ENV !== "development";
}

const routeFunctionCache = new WeakMap<MetadataRuntimeRoute, MetadataRouteFunctions>();
const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");
const CACHE_HEADERS = {
  noCache: "no-cache, no-store",
  revalidate: "public, max-age=0, must-revalidate",
} as const;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function readFunction(
  module: Record<string, unknown> | undefined,
  key: string,
): MetadataRouteFunction | null {
  if (!module) {
    return null;
  }
  const value = Reflect.get(module, key);
  if (typeof value !== "function") {
    return null;
  }
  const fn: MetadataRouteFunction = (props) => Reflect.apply(value, module, [props]);
  if (Reflect.get(value, USE_CACHE_FUNCTION_SYMBOL) === true) {
    Reflect.set(fn, USE_CACHE_FUNCTION_SYMBOL, true);
  }
  return fn;
}

function isSitemapEntries(value: unknown): value is SitemapEntry[] {
  return Array.isArray(value);
}

function isRobotsConfig(value: unknown): value is RobotsConfig {
  return isObject(value) && !Array.isArray(value);
}

function isManifestConfig(value: unknown): value is ManifestConfig {
  return isObject(value) && !Array.isArray(value);
}

function isImageMetadataRoute(route: MetadataRuntimeRoute): boolean {
  return (
    route.type === "icon" ||
    route.type === "apple-icon" ||
    route.type === "opengraph-image" ||
    route.type === "twitter-image"
  );
}

function metadataRouteCacheHeader(route: MetadataRuntimeRoute): string {
  if (route.isDynamic && isImageMetadataRoute(route) && process.env.NODE_ENV === "development") {
    return CACHE_HEADERS.noCache;
  }
  return CACHE_HEADERS.revalidate;
}

function withMetadataRouteCacheHeader(response: Response, route: MetadataRuntimeRoute): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", metadataRouteCacheHeader(route));
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function getMetadataRouteFunctions(route: MetadataRuntimeRoute): MetadataRouteFunctions {
  const cached = routeFunctionCache.get(route);
  if (cached) {
    return cached;
  }

  const generateImageMetadata =
    route.isDynamic && isImageMetadataRoute(route)
      ? readFunction(route.module, "generateImageMetadata")
      : null;
  const functions = {
    defaultExport: route.isDynamic ? readFunction(route.module, "default") : null,
    generateImageMetadata,
    generateSitemaps:
      route.type === "sitemap" && route.isDynamic
        ? readFunction(route.module, "generateSitemaps")
        : null,
    hasGeneratedImageMetadata:
      route.isDynamic && isImageMetadataRoute(route) && Boolean(generateImageMetadata),
  };
  routeFunctionCache.set(route, functions);
  return functions;
}

function isUseCacheFunction(value: MetadataRouteFunction | null): boolean {
  return value !== null && Reflect.get(value, USE_CACHE_FUNCTION_SYMBOL) === true;
}

/**
 * Enumerate metadata URLs whose default export is an explicit public
 * `"use cache"` function. These are safe to invoke during prerendering and the
 * resulting response can be seeded as an App Route artifact.
 */
export async function getPrerenderableMetadataRoutePaths(
  metadataRoutes: readonly MetadataRuntimeRoute[],
): Promise<PrerenderableMetadataRoute[]> {
  const paths: PrerenderableMetadataRoute[] = [];

  for (const route of metadataRoutes) {
    if (!route.isDynamic || route.servedUrl.includes("[")) continue;

    const functions = getMetadataRouteFunctions(route);
    if (!isUseCacheFunction(functions.defaultExport)) continue;

    if (route.type !== "sitemap" || !functions.generateSitemaps) {
      paths.push({
        path: route.servedUrl,
        routePattern: route.servedUrl,
        routeSegments: route.routeSegments ?? [],
      });
      continue;
    }

    const entries = await functions.generateSitemaps({});
    if (!Array.isArray(entries)) continue;
    const sitemapPrefix = route.servedUrl.slice(0, -4);
    for (const entry of entries) {
      if (!isObject(entry) || Reflect.get(entry, "id") == null) {
        throw new Error("id property is required for every item returned from generateSitemaps");
      }
      const id = String(Reflect.get(entry, "id"));
      if (!id || id.includes("/")) continue;
      paths.push({
        path: `${sitemapPrefix}/${encodeURIComponent(id)}.xml`,
        routePattern: route.servedUrl,
        routeSegments: route.routeSegments ?? [],
      });
    }
  }

  return paths;
}

function getCachedMetadataRouteValue(entry: ISRCacheEntry | null): CachedRouteValue | null {
  const value = entry?.value.value;
  if (!value || value.kind !== "APP_ROUTE") return null;
  return value.headers[VINEXT_METADATA_ROUTE_CACHE_HEADER] === "1" ? value : null;
}

function buildCachedMetadataRouteResponse(
  value: CachedRouteValue,
  options: {
    cacheControl: ISRCacheEntry["value"]["cacheControl"];
    cacheState: "HIT" | "STALE";
    revalidateSeconds: number;
  },
): Response {
  return buildRouteHandlerCachedResponse(value, {
    ...options,
    isHead: false,
  });
}

function markMetadataRouteCacheValue(value: CachedRouteValue): CachedRouteValue {
  value.headers[VINEXT_METADATA_ROUTE_CACHE_HEADER] = "1";
  return value;
}

function buildMetadataRouteTags(
  route: MetadataRuntimeRoute,
  cleanPathname: string,
  collectedTags: string[],
): string[] {
  return buildPageCacheTags(cleanPathname, collectedTags, route.routeSegments ?? [], "route");
}

function captureRenderedMetadataRoute(response: Response): RenderedMetadataRoute {
  const cacheLife = _consumeRequestScopedCacheLife();
  const collectedTags = getCollectedFetchTags();
  if (process.env.VINEXT_PRERENDER === "1") {
    applyPrerenderCacheLifeHeader(response.headers, cacheLife);
    applyPrerenderCacheTagsHeader(response.headers, collectedTags);
  }
  return { cacheLife, collectedTags, response };
}

async function writeRenderedMetadataRoute(
  options: MetadataRouteRequestOptions,
  route: MetadataRuntimeRoute,
  routeKey: string,
  rendered: RenderedMetadataRoute,
  previousEntry: ISRCacheEntry | null,
): Promise<void> {
  if (!options.isrSet || !rendered.response.ok || !isMetadataResponseCacheable(rendered.response)) {
    return;
  }
  const previousCacheControl = previousEntry?.value.cacheControl;
  const defaultCacheLife = cacheLifeProfiles.default;
  const revalidate =
    rendered.cacheLife?.revalidate ??
    previousCacheControl?.revalidate ??
    defaultCacheLife.revalidate ??
    900;
  const expire =
    rendered.cacheLife?.expire ?? previousCacheControl?.expire ?? defaultCacheLife.expire;
  const stale = resolveClientStaleTimeSeconds(rendered.cacheLife) ?? previousCacheControl?.stale;
  const value = markMetadataRouteCacheValue(await buildAppRouteCacheValue(rendered.response));
  await options.isrSet(routeKey, value, {
    cacheControl: isrCacheControl(revalidate, {
      ...(typeof expire === "number" ? { expireSeconds: expire } : {}),
      ...(typeof stale === "number" ? { staleSeconds: stale } : {}),
    }),
    tags: buildMetadataRouteTags(route, options.cleanPathname, rendered.collectedTags),
  });
}

async function runMetadataRouteRegeneration(
  options: MetadataRouteRequestOptions,
  route: MetadataRuntimeRoute,
  render: () => Promise<RenderedMetadataRoute | null>,
  routeKey: string,
  previousEntry: ISRCacheEntry,
  executionContext: ReturnType<typeof getRequestExecutionContext>,
): Promise<void> {
  const requestContext = createRequestContext({ executionContext });
  try {
    await runWithRequestContext(requestContext, async () => {
      ensureFetchPatch();
      setCurrentFetchSoftTags(buildMetadataRouteTags(route, options.cleanPathname, []));
      const rendered = await render();
      if (rendered) {
        await writeRenderedMetadataRoute(options, route, routeKey, rendered, previousEntry);
      }
    });
  } finally {
    await closeAfterResponse(requestContext);
  }
}

async function readMatchedPrerenderedMetadataRouteResponse(
  options: MetadataRouteRequestOptions,
  route: MetadataRuntimeRoute,
  functions: MetadataRouteFunctions,
  render: () => Promise<RenderedMetadataRoute | null>,
): Promise<{ cachedEntry: ISRCacheEntry | null; response: Response | null }> {
  if (!isOuterMetadataCacheEnabled() || !options.isrGet || !options.isrRouteKey) {
    return { cachedEntry: null, response: null };
  }

  const routeKey = options.isrRouteKey(options.cleanPathname);
  let cached: ISRCacheEntry | null;
  try {
    cached = await options.isrGet(routeKey);
  } catch (error) {
    console.error("[vinext] Metadata route ISR cache read error:", error);
    return { cachedEntry: null, response: null };
  }
  const value = getCachedMetadataRouteValue(cached);
  if (!cached || !value) {
    return { cachedEntry: null, response: null };
  }
  if (cached.isExpired) {
    return { cachedEntry: cached, response: null };
  }

  const revalidate = cached.value.cacheControl?.revalidate;
  const revalidateSeconds = typeof revalidate === "number" ? revalidate : Infinity;
  if (!cached.isStale) {
    return {
      cachedEntry: cached,
      response: buildCachedMetadataRouteResponse(value, {
        cacheControl: cached.value.cacheControl,
        cacheState: "HIT",
        revalidateSeconds,
      }),
    };
  }

  if (
    isUseCacheFunction(functions.defaultExport) &&
    options.isrSet &&
    options.scheduleBackgroundRegeneration
  ) {
    const executionContext = getRequestExecutionContext();
    options.scheduleBackgroundRegeneration(
      routeKey,
      () =>
        runMetadataRouteRegeneration(options, route, render, routeKey, cached, executionContext),
      {
        routerKind: "App Router",
        routePath: route.servedUrl,
        routeType: "route",
      },
    );
  }

  return {
    cachedEntry: cached,
    response: buildCachedMetadataRouteResponse(value, {
      cacheControl: cached.value.cacheControl,
      cacheState: "STALE",
      revalidateSeconds,
    }),
  };
}

function isGeneratedSitemapPath(route: MetadataRuntimeRoute, cleanPathname: string): boolean {
  const prefix = route.servedUrl.slice(0, -4);
  if (!cleanPathname.startsWith(`${prefix}/`) || !cleanPathname.endsWith(".xml")) return false;
  const id = cleanPathname.slice(prefix.length + 1, -4);
  return id.length > 0 && !id.includes("/");
}

function matchMetadataRoute(
  route: MetadataRuntimeRoute,
  cleanPathname: string,
  functions: MetadataRouteFunctions,
  getUrlParts: () => string[],
): MatchedMetadataRoute | null {
  if (route.patternParts) {
    const urlParts = getUrlParts();
    if (functions.hasGeneratedImageMetadata && urlParts.length > 0) {
      const params = matchMetadataRoutePattern(urlParts.slice(0, -1), route.patternParts);
      if (params) {
        return {
          params,
          imageId: urlParts[urlParts.length - 1],
        };
      }
    }

    const params = matchMetadataRoutePattern(urlParts, route.patternParts);
    return params ? { params, imageId: null } : null;
  }

  if (functions.hasGeneratedImageMetadata && cleanPathname.startsWith(`${route.servedUrl}/`)) {
    const imageSuffix = cleanPathname.slice(route.servedUrl.length + 1);
    if (!imageSuffix || imageSuffix.includes("/")) {
      return null;
    }
    return { params: Object.create(null), imageId: imageSuffix };
  }

  return cleanPathname === route.servedUrl ? { params: null, imageId: null } : null;
}

function findGeneratedSitemapId(entries: unknown, rawId: string): string | null {
  if (!Array.isArray(entries)) {
    return null;
  }

  for (const entry of entries) {
    if (!isObject(entry) || Reflect.get(entry, "id") == null) {
      throw new Error("id property is required for every item returned from generateSitemaps");
    }
    const id = Reflect.get(entry, "id");
    if (String(id) === rawId) {
      return rawId;
    }
  }

  return null;
}

function makeThenableMetadataRouteId(id: string) {
  return Object.assign(Promise.resolve(id), {
    toString() {
      return id;
    },
    valueOf() {
      return id;
    },
    [Symbol.toPrimitive]() {
      return id;
    },
  });
}

async function handleGeneratedSitemap(
  route: MetadataRuntimeRoute,
  cleanPathname: string,
  functions: MetadataRouteFunctions,
): Promise<Response | null> {
  if (!functions.generateSitemaps || !functions.defaultExport) {
    return null;
  }

  const sitemapPrefix = route.servedUrl.slice(0, -4);
  if (!cleanPathname.startsWith(`${sitemapPrefix}/`) || !cleanPathname.endsWith(".xml")) {
    return null;
  }

  const rawId = cleanPathname.slice(sitemapPrefix.length + 1, -4);
  if (rawId.includes("/")) {
    return null;
  }

  const matchedId = findGeneratedSitemapId(await functions.generateSitemaps({}), rawId);
  if (!matchedId) {
    return notFoundResponse();
  }

  const result = await functions.defaultExport({
    id: makeThenableMetadataRouteId(matchedId),
  });
  if (result instanceof Response) {
    return withMetadataRouteCacheHeader(result, route);
  }
  if (!isSitemapEntries(result)) {
    throw new TypeError("Metadata sitemap routes must return an array.");
  }
  // Body serialized to a string here — fully materialized, no producer left.
  return markFullyBufferedBody(
    new Response(sitemapToXml(result), {
      headers: {
        "Content-Type": route.contentType,
        "Cache-Control": metadataRouteCacheHeader(route),
      },
    }),
  );
}

function findGeneratedImageId(
  imageMetadata: unknown,
  imageId: string,
  servedUrl: string,
): string | null {
  if (!Array.isArray(imageMetadata)) {
    return null;
  }

  for (const item of imageMetadata) {
    if (!isObject(item) || Reflect.get(item, "id") == null) {
      throw new Error("id property is required for every item returned from generateImageMetadata");
    }

    const itemId = String(Reflect.get(item, "id"));
    if (!isValidMetadataImageId(itemId)) {
      console.warn(
        `[vinext] Skipping metadata route ${servedUrl} image id "${itemId}" because metadata image ids must match /^[a-zA-Z0-9-_.]+$/.`,
      );
      continue;
    }
    if (itemId === imageId) {
      return itemId;
    }
  }

  return null;
}

async function callDynamicMetadataRoute(
  route: MetadataRuntimeRoute,
  match: MatchedMetadataRoute,
  makeThenableParams: MetadataRouteMakeThenableParams,
  functions: MetadataRouteFunctions,
): Promise<Response> {
  if (!functions.defaultExport) {
    console.warn(`[vinext] Dynamic metadata route ${route.servedUrl} has no default export.`);
    return notFoundResponse();
  }

  const paramsThenable = makeThenableParams(match.params ?? {});
  let result: unknown;
  if (functions.hasGeneratedImageMetadata) {
    if (match.imageId === null || !isValidMetadataImageId(match.imageId)) {
      return notFoundResponse();
    }

    if (!functions.generateImageMetadata) {
      return notFoundResponse();
    }

    const matchedImageId = findGeneratedImageId(
      await functions.generateImageMetadata({ params: paramsThenable }),
      match.imageId,
      route.servedUrl,
    );
    if (!matchedImageId) {
      return notFoundResponse();
    }

    result = await functions.defaultExport({
      params: paramsThenable,
      id: makeThenableMetadataRouteId(matchedImageId),
    });
  } else {
    result = await functions.defaultExport({ params: paramsThenable });
  }

  if (result instanceof Response) {
    return withMetadataRouteCacheHeader(result, route);
  }

  let body: string;
  if (route.type === "sitemap") {
    if (!isSitemapEntries(result)) {
      throw new TypeError("Metadata sitemap routes must return an array.");
    }
    body = sitemapToXml(result);
  } else if (route.type === "robots") {
    if (!isRobotsConfig(result)) {
      throw new TypeError("Metadata robots routes must return an object.");
    }
    body = robotsToText(result);
  } else if (route.type === "manifest") {
    if (!isManifestConfig(result)) {
      throw new TypeError("Metadata manifest routes must return an object.");
    }
    body = manifestToJson(result);
  } else if (isImageMetadataRoute(route)) {
    throw new TypeError(
      `Dynamic metadata ${route.type} route ${route.servedUrl} must return a Response.`,
    );
  } else {
    body = JSON.stringify(result);
  }

  // Every branch above serialized `result` to a string — fully materialized.
  return markFullyBufferedBody(
    new Response(body, {
      headers: {
        "Content-Type": route.contentType,
        "Cache-Control": metadataRouteCacheHeader(route),
      },
    }),
  );
}

function serveStaticMetadataRoute(route: MetadataRuntimeRoute): Response {
  if (typeof route.fileDataBase64 !== "string") {
    throw new Error(
      `[vinext] Static metadata route ${route.servedUrl} is missing embedded file data.`,
    );
  }

  try {
    const binary = atob(route.fileDataBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    // Static file bytes, fully in memory — no producer left.
    return markFullyBufferedBody(
      new Response(bytes, {
        headers: {
          "Content-Type": route.contentType,
          "Cache-Control": metadataRouteCacheHeader(route),
        },
      }),
    );
  } catch (error) {
    const reason = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(
      `[vinext] Failed to decode embedded metadata route file data for ${route.servedUrl}${reason}`,
      { cause: error },
    );
  }
}

export function isMetadataRouteRequestPath(
  metadataRoutes: readonly MetadataRuntimeRoute[],
  cleanPathname: string,
): boolean {
  let urlParts: string[] | undefined;
  const getUrlParts = () => (urlParts ??= cleanPathname.split("/").filter(Boolean));
  for (const route of metadataRoutes) {
    const functions = getMetadataRouteFunctions(route);
    if (
      route.type === "sitemap" &&
      route.isDynamic &&
      functions.generateSitemaps &&
      isGeneratedSitemapPath(route, cleanPathname)
    ) {
      return true;
    }
    if (matchMetadataRoute(route, cleanPathname, functions, getUrlParts)) {
      return true;
    }
  }
  return false;
}

async function writeMetadataRouteMiss(
  options: MetadataRouteRequestOptions,
  route: MetadataRuntimeRoute,
  functions: MetadataRouteFunctions,
  rendered: RenderedMetadataRoute,
  cachedEntry: ISRCacheEntry | null,
): Promise<void> {
  if (
    process.env.VINEXT_PRERENDER === "1" ||
    !isOuterMetadataCacheEnabled() ||
    !rendered.response.ok ||
    !isMetadataResponseCacheable(rendered.response) ||
    !isUseCacheFunction(functions.defaultExport) ||
    !options.isrRouteKey ||
    !options.isrSet
  ) {
    return;
  }
  try {
    await writeRenderedMetadataRoute(
      options,
      route,
      options.isrRouteKey(options.cleanPathname),
      { ...rendered, response: rendered.response.clone() },
      cachedEntry,
    );
  } catch (error) {
    console.error("[vinext] Metadata route ISR cache write error:", error);
  }
}

export async function handleMetadataRouteRequest(
  options: MetadataRouteRequestOptions,
): Promise<Response | null> {
  // `cleanPathname` is invariant across the loop, so its split is computed
  // lazily and memoized: only dynamic (`patternParts`) routes need it, and the
  // common case of zero dynamic metadata routes never splits at all.
  let urlParts: string[] | undefined;
  const getUrlParts = () => (urlParts ??= options.cleanPathname.split("/").filter(Boolean));

  for (const route of options.metadataRoutes) {
    const functions = getMetadataRouteFunctions(route);
    if (route.type === "sitemap" && route.isDynamic) {
      if (functions.generateSitemaps) {
        if (isGeneratedSitemapPath(route, options.cleanPathname)) {
          const render = async (): Promise<RenderedMetadataRoute | null> => {
            setCurrentFetchSoftTags(buildMetadataRouteTags(route, options.cleanPathname, []));
            const response = await handleGeneratedSitemap(route, options.cleanPathname, functions);
            return response ? captureRenderedMetadataRoute(response) : null;
          };
          const cached = await readMatchedPrerenderedMetadataRouteResponse(
            options,
            route,
            functions,
            render,
          );
          if (cached.response) return cached.response;
          const rendered = await render();
          if (rendered) {
            await writeMetadataRouteMiss(options, route, functions, rendered, cached.cachedEntry);
            return rendered.response;
          }
        }

        // Next.js serves only generated sitemap children when generateSitemaps()
        // exists, so the base /sitemap.xml route should not fall through.
        continue;
      }
    }

    const match = matchMetadataRoute(route, options.cleanPathname, functions, getUrlParts);
    if (!match) {
      continue;
    }

    const render = async (): Promise<RenderedMetadataRoute> => {
      setCurrentFetchSoftTags(buildMetadataRouteTags(route, options.cleanPathname, []));
      const response = route.isDynamic
        ? await callDynamicMetadataRoute(route, match, options.makeThenableParams, functions)
        : serveStaticMetadataRoute(route);
      return captureRenderedMetadataRoute(response);
    };
    const cached = await readMatchedPrerenderedMetadataRouteResponse(
      options,
      route,
      functions,
      render,
    );
    if (cached.response) return cached.response;

    const rendered = await render();
    await writeMetadataRouteMiss(options, route, functions, rendered, cached.cachedEntry);
    return rendered.response;
  }

  return null;
}
