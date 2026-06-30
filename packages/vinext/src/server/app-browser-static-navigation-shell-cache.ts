import {
  createCachedRscResponseSnapshot,
  restoreRscResponse,
  type CachedRscResponse,
} from "vinext/shims/navigation";
import { AppElementsWire } from "./app-elements.js";
import {
  createRscRequestHeaders,
  createRscRequestUrl,
  isRscCompatibilityIdCompatible,
  stripRscCacheBustingSearchParam,
  stripRscSuffix,
  VINEXT_RSC_CONTENT_TYPE,
} from "./app-rsc-cache-busting.js";
import { APP_RSC_RENDER_MODE_STATIC_NAVIGATION_SHELL } from "./app-rsc-render-mode.js";
import {
  RSC_HEADER,
  VINEXT_PARAMS_HEADER,
  VINEXT_RSC_REDIRECT_HEADER,
  VINEXT_STATIC_NAVIGATION_SHELL_COMPLETE_HEADER,
  VINEXT_STATIC_NAVIGATION_SHELL_STALE_TIME_HEADER,
} from "./headers.js";
import { parseRouteParamsHeader, type RouteParams } from "../utils/route-params.js";

type CanonicalStaticNavigationShellUrl = {
  href: string;
  origin: string;
};

export type StaticNavigationShellCacheEntry = {
  complete: boolean;
  expiresAt: number;
  mountedSlotsHeader: string | null;
  params: RouteParams;
  response: CachedRscResponse;
};

type StaticNavigationShellCacheKey = {
  interceptionContext: string | null;
  rscUrl: string;
};

type StaticNavigationShellLookup = StaticNavigationShellCacheKey & {
  mountedSlotsHeader: string | null;
};

export type StaticNavigationShellFetchInit = {
  credentials: "include";
  headers: Headers;
};

type StaticNavigationShellSeedOptions = StaticNavigationShellLookup & {
  href: string;
  origin: string;
};

type StaticNavigationShellSeedResult =
  | { kind: "disabled" }
  | { kind: "scheduled" }
  | { kind: "stored"; stored: boolean };

export type StaticNavigationShellCache = {
  clear(): void;
  delete(key: StaticNavigationShellCacheKey): void;
  read(lookup: StaticNavigationShellLookup): StaticNavigationShellCacheEntry | null;
  seed(options: StaticNavigationShellSeedOptions): Promise<StaticNavigationShellSeedResult>;
  seedInitial(options: { href: string; origin: string }): Promise<StaticNavigationShellSeedResult>;
};

type StaticNavigationShellFetch = (
  url: string,
  init: StaticNavigationShellFetchInit,
) => Promise<Response>;

type CreateStaticNavigationShellCacheOptions = {
  awaitSeedCompletion?: boolean;
  fetchShell?: StaticNavigationShellFetch;
  maxEntries: number;
  now?: () => number;
};

function areCachedNavigationsEnabled(): boolean {
  return (
    String(process.env.__NEXT_CACHE_COMPONENTS) === "true" &&
    String(process.env.__NEXT_CACHED_NAVIGATIONS) === "true"
  );
}

function getDefaultStaticNavigationShellTtlMs(): number {
  const value = process.env.__NEXT_CLIENT_ROUTER_STATIC_STALETIME;
  if (value !== undefined && value !== "") {
    const staleSeconds = Number(value);
    if (Number.isFinite(staleSeconds) && staleSeconds >= 0) {
      return staleSeconds * 1_000;
    }
  }
  return 300_000;
}

function isStaticNavigationShellComplete(response: Response): boolean {
  return response.headers.get(VINEXT_STATIC_NAVIGATION_SHELL_COMPLETE_HEADER) === "1";
}

function readStaticNavigationShellTtlMs(response: Response): number | null {
  const value = response.headers.get(VINEXT_STATIC_NAVIGATION_SHELL_STALE_TIME_HEADER);
  if (value === null || value.trim() === "") {
    return null;
  }

  const staleSeconds = Number(value);
  if (Number.isFinite(staleSeconds) && staleSeconds >= 0) {
    return staleSeconds * 1_000;
  }
  return null;
}

function staticNavigationShellCacheKey(key: StaticNavigationShellCacheKey): string {
  return AppElementsWire.encodeCacheKey(key.rscUrl, key.interceptionContext);
}

function staticNavigationShellPendingSeedKey(key: StaticNavigationShellLookup): string {
  return AppElementsWire.encodeCacheKey(staticNavigationShellCacheKey(key), key.mountedSlotsHeader);
}

async function createStaticNavigationShellRequestUrl(
  options: Pick<StaticNavigationShellSeedOptions, "href" | "origin"> & { headers: Headers },
): Promise<string> {
  const rscUrl = await createRscRequestUrl(options.href, options.headers);
  const url = new URL(rscUrl, options.origin);
  url.pathname = `${url.pathname}.rsc`;
  return `${url.pathname}${url.search}`;
}

function readCanonicalStaticNavigationShellUrl(
  rawUrl: string,
  origin: string,
): CanonicalStaticNavigationShellUrl | null {
  if (rawUrl === "") return null;

  const url = new URL(rawUrl, origin);
  stripRscCacheBustingSearchParam(url);
  url.pathname = stripRscSuffix(url.pathname);
  return {
    href: `${url.pathname}${url.search}`,
    origin: url.origin,
  };
}

function isStaticNavigationShellResponseCacheable(options: {
  href: string;
  origin: string;
  response: Response;
}): boolean {
  if (options.response.headers.has(VINEXT_RSC_REDIRECT_HEADER)) {
    return false;
  }

  const responseUrl = readCanonicalStaticNavigationShellUrl(options.response.url, options.origin);
  if (responseUrl === null) {
    return false;
  }

  const expectedUrl = readCanonicalStaticNavigationShellUrl(options.href, options.origin);
  return (
    expectedUrl !== null &&
    responseUrl.origin === expectedUrl.origin &&
    responseUrl.href === expectedUrl.href
  );
}

function isStaticNavigationShellEntryCompatible(entry: StaticNavigationShellCacheEntry): boolean {
  return isRscCompatibilityIdCompatible(entry.response.compatibilityIdHeader ?? null);
}

function restorePartialStaticNavigationShellResponse(cached: CachedRscResponse): Response {
  const headers = restoreRscResponse(cached).headers;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(cached.buffer.slice(0)));
      },
    }),
    {
      headers,
      status: 200,
    },
  );
}

export function restoreStaticNavigationShellResponse(
  entry: StaticNavigationShellCacheEntry,
): Response {
  return entry.complete
    ? restoreRscResponse(entry.response)
    : restorePartialStaticNavigationShellResponse(entry.response);
}

function defaultFetchShell(url: string, init: StaticNavigationShellFetchInit): Promise<Response> {
  return fetch(url, init);
}

export function createStaticNavigationShellCache(
  options: CreateStaticNavigationShellCacheOptions,
): StaticNavigationShellCache {
  const entries = new Map<string, StaticNavigationShellCacheEntry>();
  const pendingSeeds = new Map<string, Promise<boolean>>();
  let generation = 0;
  const fetchShell = options.fetchShell ?? defaultFetchShell;
  const maxEntries = Math.max(0, Math.floor(options.maxEntries));
  const now = options.now ?? (() => Date.now());

  function store(options: {
    interceptionContext: string | null;
    mountedSlotsHeader: string | null;
    params: RouteParams;
    response: CachedRscResponse;
    rscUrl: string;
    shellResponse: Response;
  }): boolean {
    if (maxEntries === 0) return false;

    const complete = isStaticNavigationShellComplete(options.shellResponse);
    const ttlMs =
      readStaticNavigationShellTtlMs(options.shellResponse) ??
      (complete ? getDefaultStaticNavigationShellTtlMs() : null);
    if (ttlMs === null) return false;

    const cacheKey = staticNavigationShellCacheKey(options);
    entries.delete(cacheKey);
    while (entries.size >= maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    entries.set(cacheKey, {
      complete,
      expiresAt: now() + ttlMs,
      mountedSlotsHeader: options.mountedSlotsHeader,
      params: options.params,
      response: options.response,
    });
    return true;
  }

  async function seedAndWait(seedOptions: StaticNavigationShellSeedOptions): Promise<boolean> {
    if (!areCachedNavigationsEnabled()) return false;

    const startedGeneration = generation;
    const shellHeaders = createRscRequestHeaders({
      interceptionContext: seedOptions.interceptionContext,
      mountedSlotsHeader: seedOptions.mountedSlotsHeader,
      renderMode: APP_RSC_RENDER_MODE_STATIC_NAVIGATION_SHELL,
    });
    const shellUrl = await createStaticNavigationShellRequestUrl({
      headers: shellHeaders,
      href: seedOptions.href,
      origin: seedOptions.origin,
    });
    shellHeaders.delete(RSC_HEADER);

    const shellResponse = await fetchShell(shellUrl, {
      credentials: "include",
      headers: shellHeaders,
    });
    const contentType = shellResponse.headers.get("content-type") ?? "";
    if (
      !shellResponse.ok ||
      !contentType.startsWith(VINEXT_RSC_CONTENT_TYPE) ||
      !shellResponse.body ||
      !isStaticNavigationShellResponseCacheable({
        href: seedOptions.href,
        origin: seedOptions.origin,
        response: shellResponse,
      })
    ) {
      return false;
    }

    const params = parseRouteParamsHeader(shellResponse.headers.get(VINEXT_PARAMS_HEADER)) ?? {};
    const buffer = await shellResponse.arrayBuffer();
    if (!isStaticNavigationShellComplete(shellResponse) && buffer.byteLength === 0) {
      return false;
    }
    if (startedGeneration !== generation) {
      return false;
    }
    return store({
      interceptionContext: seedOptions.interceptionContext,
      mountedSlotsHeader: seedOptions.mountedSlotsHeader,
      params,
      response: createCachedRscResponseSnapshot(shellResponse, buffer, shellResponse.url),
      rscUrl: seedOptions.rscUrl,
      shellResponse,
    });
  }

  function startSeed(seedOptions: StaticNavigationShellSeedOptions): Promise<boolean> {
    const pendingKey = staticNavigationShellPendingSeedKey(seedOptions);
    const pendingSeed = pendingSeeds.get(pendingKey);
    if (pendingSeed !== undefined) {
      return pendingSeed;
    }

    const seedPromise = seedAndWait(seedOptions);
    pendingSeeds.set(pendingKey, seedPromise);
    void seedPromise.then(
      () => {
        if (pendingSeeds.get(pendingKey) === seedPromise) {
          pendingSeeds.delete(pendingKey);
        }
      },
      () => {
        if (pendingSeeds.get(pendingKey) === seedPromise) {
          pendingSeeds.delete(pendingKey);
        }
      },
    );
    return seedPromise;
  }

  function seed(
    seedOptions: StaticNavigationShellSeedOptions,
  ): Promise<StaticNavigationShellSeedResult> {
    if (!areCachedNavigationsEnabled()) return Promise.resolve({ kind: "disabled" });

    const seedPromise = startSeed(seedOptions);
    if (options.awaitSeedCompletion === true) {
      return seedPromise.then((stored) => ({ kind: "stored", stored }));
    }

    void seedPromise.catch(() => {});
    return Promise.resolve({ kind: "scheduled" });
  }

  return {
    clear() {
      generation++;
      entries.clear();
      pendingSeeds.clear();
    },
    delete(key) {
      entries.delete(staticNavigationShellCacheKey(key));
    },
    read(lookup) {
      if (!areCachedNavigationsEnabled()) return null;

      const cacheKey = staticNavigationShellCacheKey(lookup);
      const cached = entries.get(cacheKey);
      if (cached === undefined) {
        return null;
      }

      if (
        cached.mountedSlotsHeader !== lookup.mountedSlotsHeader ||
        now() >= cached.expiresAt ||
        !isStaticNavigationShellEntryCompatible(cached)
      ) {
        entries.delete(cacheKey);
        return null;
      }

      entries.delete(cacheKey);
      entries.set(cacheKey, cached);
      return cached;
    },
    seed,
    async seedInitial(seedOptions) {
      if (!areCachedNavigationsEnabled()) return { kind: "disabled" };

      const requestHeaders = createRscRequestHeaders();
      const rscUrl = await createRscRequestUrl(seedOptions.href, requestHeaders);
      return seed({
        href: seedOptions.href,
        interceptionContext: null,
        mountedSlotsHeader: null,
        origin: seedOptions.origin,
        rscUrl,
      });
    },
  };
}
