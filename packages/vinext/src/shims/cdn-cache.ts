/**
 * CDN cache adapter — owns the *page-level ISR serving strategy*.
 *
 * This is deliberately distinct from the data cache handler (see `./cache.ts`):
 *
 * - The **data cache** stores cached data (fetch, `"use cache"`,
 *   `unstable_cache`, route-handler data). It is a pure key/value store.
 *
 * - The **CDN cache adapter** decides *how page-level ISR is served*: where the
 *   rendered page/route/image artifacts live, what cache headers the response
 *   carries, whether the origin runs background regeneration, and how
 *   invalidation propagates to a CDN edge.
 *
 * Two strategies sit behind one interface:
 *
 * | Concern            | DefaultCdnCacheAdapter (origin-managed) | Edge adapter (CDN-managed)                  |
 * | ------------------ | --------------------------------------- | ------------------------------------------- |
 * | Serve from store?  | Yes — reads the data cache              | No — origin renders fresh, edge caches      |
 * | Background regen   | In-process via `waitUntil`              | Edge re-requests origin                     |
 * | Response headers   | Framework cache policy                  | Provider-specific cache policy                         |
 * | Invalidation       | (data cache handles tag invalidation)   | purge / revalidate via request context      |
 *
 * The default adapter is a thin shim over the data cache + the framework's
 * existing header logic, so default behavior is byte-for-byte identical to the
 * pre-split implementation.
 */

import {
  getDataCacheHandler,
  type CacheHandlerValue,
  type IncrementalCacheValue,
} from "./cache-handler.js";
import { getRequestContext, isInsideUnifiedScope } from "./unified-request-context.js";

/** A map of response header name -> value the adapter wants applied or removed. */
export type CdnResponseHeaders = Record<string, string | null>;

export type CdnCacheableHeaderInput = {
  /**
   * The cacheable `Cache-Control` value the framework computed for shared
   * caches (e.g. `s-maxage=60, stale-while-revalidate`). May be an empty string
   * when no cacheable policy applies.
   */
  cacheControl: string;
  /**
   * True when this is a freshly-rendered **streaming** response whose
   * dynamic-ness is not yet proven (late Server Component request-API usage can
   * only be detected after the stream drains).
   *
   * The default adapter forces `no-store` for the browser in this case — the
   * page is instead served from the origin store on subsequent requests. Edge
   * adapters may instead emit edge-only cache headers so the CDN performs SWR
   * while the browser receives a separate policy.
   */
  pendingDynamicCheck?: boolean;
  /**
   * The cache tags associated with this page/route, already canonicalised
   * (e.g. via `encodeCacheTag`). Edge adapters use these to emit a tag header
   * so tag-based purging can target the response.
   * The default adapter ignores them.
   */
  tags?: readonly string[];
};

/** Whether a Cache-Control value contains an exact non-cacheable directive. */
export function isNonCacheableCacheControl(cacheControl: string): boolean {
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index <= cacheControl.length; index++) {
    const char = cacheControl[index];
    if (index === cacheControl.length || (char === "," && !quoted)) {
      const directive = cacheControl.slice(start, index);
      const equals = directive.indexOf("=");
      const name = (equals === -1 ? directive : directive.slice(0, equals)).trim().toLowerCase();
      if (name === "no-store" || (equals === -1 && (name === "private" || name === "no-cache"))) {
        return true;
      }
      start = index + 1;
      continue;
    }

    if (quoted && char === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (char === '"' && !escaped) quoted = !quoted;
    escaped = false;
  }

  return false;
}

/**
 * The serving strategy for page-level ISR. Implement this to delegate
 * page/route/image caching to a CDN edge instead of the origin store.
 */
// Method names mirror the data cache adapter (`CacheHandler` in `./cache.ts`:
// `get` / `set` / `revalidateTag`) so the two adapters read consistently.
// `buildResponseHeaders` / `ownsBackgroundRevalidation` have no data-cache
// equivalent and stay CDN-specific.
export type CdnCacheAdapter = {
  /**
   * Validate provider-specific request routing before the application handles
   * the request. Returning a response short-circuits the request pipeline;
   * returning `null` continues normally.
   *
   * Core deliberately passes the untouched request and does not interpret any
   * provider headers or bindings itself.
   */
  validateRequest?(request: Request): Response | null | Promise<Response | null>;

  /**
   * Read a page-level artifact. Returning a value lets the origin serve it
   * (HIT/STALE); returning `null` makes the origin render fresh.
   *
   * Default: reads the data cache. Edge adapters typically return `null` so the
   * edge owns serving.
   */
  get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null>;

  /**
   * Persist a freshly-rendered page-level artifact.
   *
   * Default: writes to the data cache. Edge adapters that rely entirely on the
   * CDN may make this a no-op.
   */
  set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void>;

  /**
   * Build the response cache headers for a given policy. Returns a map so an
   * adapter can emit more than one header and remove stale adapter-owned
   * headers with `null`. Adapters must return `null` for every header they own
   * when the input policy should remove it; core never infers provider header
   * names or deletes headers the active adapter did not claim.
   */
  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders;

  /**
   * Build adapter-owned headers that identify the deployed application build.
   * Core applies these at the outer page-response boundary, including response
   * paths that do not pass through cache-policy finalization.
   */
  buildResponseIdentityHeaders?(): CdnResponseHeaders;

  /**
   * Whether existing response headers explicitly opt out of storage. Adapters
   * that split browser and provider cache policy should implement this so they
   * can interpret the provider-specific headers they own.
   *
   * When omitted, core inspects only the generic `Cache-Control` header.
   */
  hasExplicitNonCacheableResponsePolicy?(headers: Headers): boolean;

  /**
   * Whether the **origin** runs in-process background regeneration when a stale
   * entry is served. Edge adapters set this to `false` because the CDN
   * revalidates by re-requesting the origin.
   */
  readonly ownsBackgroundRevalidation: boolean;

  /**
   * True when a cache HIT is served without invoking the vinext request
   * pipeline. Such adapters cannot own responses whose middleware or
   * request-dependent config composition must execute on every request. Custom
   * adapters default to `true` for safety; origin-serving adapters must
   * explicitly set `false`.
   */
  readonly bypassesOriginOnCacheHit?: boolean;

  /**
   * Propagate a tag/path invalidation to the CDN edge (purge). Called *in
   * addition to* the data cache's own tag invalidation, so the default
   * implementation is a no-op (the data cache already invalidated its entries).
   *
   * Edge adapters implement this to purge the edge cache — typically firing the
   * purge through the request execution context (`ctx.waitUntil`).
   */
  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void>;
};

// `finalizeAppPage*CacheResponse` historically stamped this exact value on the
// streamed MISS response. Keep it identical so default behavior is unchanged.
const PENDING_DYNAMIC_CACHE_CONTROL = "no-store, must-revalidate";

/**
 * Default origin-managed ISR strategy: store page artifacts in the data cache,
 * serve HIT/STALE from it, run in-process background regeneration, and emit the
 * framework's standard `Cache-Control` headers. It deliberately leaves unknown
 * response headers alone. Deployments where provider headers carry cache
 * semantics must configure the adapter that owns those headers.
 */
export class DefaultCdnCacheAdapter implements CdnCacheAdapter {
  readonly bypassesOriginOnCacheHit = false;
  readonly ownsBackgroundRevalidation = true;

  async get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    return getDataCacheHandler().get(key, ctx);
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    await getDataCacheHandler().set(key, data, ctx);
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    if (input.pendingDynamicCheck) {
      // Until the stream proves the render was non-dynamic, browsers and shared
      // caches must not store it. The origin serves subsequent requests from the
      // data cache instead.
      return { "Cache-Control": PENDING_DYNAMIC_CACHE_CONTROL };
    }
    return { "Cache-Control": input.cacheControl };
  }

  async revalidateTag(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {
    // Purge-only hook. The default store is the data cache, which already
    // invalidated the matching tags, so there is nothing extra to do here.
  }
}

// ---------------------------------------------------------------------------
// Active adapter resolution.
//
// Precedence:
//   1. An adapter set explicitly via setCdnCacheAdapter() always wins. It is
//      stored on globalThis (Symbol.for) so a call in the worker entry is
//      visible across Vite environments (RSC + SSR), mirroring the data cache
//      handler resolution in cache.ts.
//   2. Otherwise, the origin-managed DefaultCdnCacheAdapter.
// ---------------------------------------------------------------------------

const _CDN_KEY = Symbol.for("vinext.cdnCacheAdapter");
const _gCdn = globalThis as unknown as Record<PropertyKey, unknown>;
const _CONFIGURED_CDN_KEY = Symbol.for("vinext.configuredCdnCacheAdapter");
type ConfiguredCdnRegistration =
  | {
      adapter: CdnCacheAdapter;
      env: unknown;
      id: string;
      kind: "generated";
    }
  | {
      adapter: CdnCacheAdapter;
      kind: "manual";
    };

let _defaultAdapter: DefaultCdnCacheAdapter | null = null;

/**
 * Set a custom CDN cache adapter to delegate page-level ISR to a CDN edge. An
 * explicit adapter always wins over the built-in request-context / default
 * selection.
 *
 * @deprecated Don't wire up the CDN cache adapter imperatively. Configure it
 * declaratively via the `cache.cdn` option on the `vinext()` plugin in your
 * `vite.config.ts`, using a config-time adapter builder. On Cloudflare Workers:
 *
 * ```ts
 * import { vinext } from "vinext";
 * import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
 *
 * export default defineConfig({
 *   plugins: [vinext({ cache: { cdn: cdnAdapter() } })],
 * });
 * ```
 *
 * The plugin registers the adapter across every runtime/router entry, so you
 * don't have to call this from a worker entry. This setter remains as the
 * internal registration target and for backwards compatibility, but is not the
 * recommended consumer API.
 */
export function setCdnCacheAdapter(adapter: CdnCacheAdapter): void {
  _gCdn[_CDN_KEY] = adapter;
  _gCdn[_CONFIGURED_CDN_KEY] = { adapter, kind: "manual" } satisfies ConfiguredCdnRegistration;
}

/** @internal Install a generated adapter and retain its build/env identity across module graphs. */
export function setConfiguredCdnCacheAdapter(
  adapter: CdnCacheAdapter,
  id: string,
  env: unknown,
): void {
  _gCdn[_CDN_KEY] = adapter;
  _gCdn[_CONFIGURED_CDN_KEY] = {
    adapter,
    env,
    id,
    kind: "generated",
  } satisfies ConfiguredCdnRegistration;
}

/** @internal Whether this generated adapter is already the active adapter. */
export function isConfiguredCdnCacheAdapterActive(id: string, env: unknown): boolean {
  const registration = _gCdn[_CONFIGURED_CDN_KEY] as ConfiguredCdnRegistration | undefined;
  return (
    registration !== undefined &&
    registration.adapter === _gCdn[_CDN_KEY] &&
    (registration.kind === "manual" || (registration.id === id && registration.env === env))
  );
}

export { deactivateGeneratedCdnCacheAdapter } from "./cache-adapter-registration.js";

const _FAILED_CDN_REGISTRATIONS_KEY = Symbol.for("vinext.failedCdnCacheAdapterRegistrations");
type FailedCdnRegistrations = {
  objectEnvs: WeakMap<object, Set<string>>;
  otherEnvs: Map<unknown, Set<string>>;
};

function getFailedCdnRegistrations(): FailedCdnRegistrations {
  return ((_gCdn[_FAILED_CDN_REGISTRATIONS_KEY] as FailedCdnRegistrations | undefined) ??= {
    objectEnvs: new WeakMap(),
    otherEnvs: new Map(),
  });
}

function failedCdnRegistrationIds(state: FailedCdnRegistrations, env: unknown): Set<string> {
  if ((typeof env === "object" && env !== null) || typeof env === "function") {
    const objectEnv = env as object;
    let ids = state.objectEnvs.get(objectEnv);
    if (!ids) state.objectEnvs.set(objectEnv, (ids = new Set()));
    return ids;
  }
  let ids = state.otherEnvs.get(env);
  if (!ids) state.otherEnvs.set(env, (ids = new Set()));
  return ids;
}

/** @internal Record a failed generated factory once per exact build/env identity. */
export function markCdnCacheAdapterRegistrationFailed(id: string, env: unknown): void {
  failedCdnRegistrationIds(getFailedCdnRegistrations(), env).add(id);
}

/** @internal Whether the exact generated factory identity already failed. */
export function hasCdnCacheAdapterRegistrationFailed(id: string, env: unknown): boolean {
  return failedCdnRegistrationIds(getFailedCdnRegistrations(), env).has(id);
}

/**
 * Get the active CDN cache adapter. An explicitly configured adapter wins;
 * otherwise the origin-managed {@link DefaultCdnCacheAdapter} is used.
 */
export function getCdnCacheAdapter(): CdnCacheAdapter {
  const active = _gCdn[_CDN_KEY] as CdnCacheAdapter | undefined;
  if (active) return active;

  return (_defaultAdapter ??= new DefaultCdnCacheAdapter());
}

/** Whether the configured custom adapter can serve a HIT above the origin. */
export function cdnCacheAdapterBypassesOriginOnHit(): boolean {
  const active = _gCdn[_CDN_KEY] as CdnCacheAdapter | undefined;
  return active !== undefined && active.bypassesOriginOnCacheHit !== false;
}

/**
 * Whether this request must keep page artifacts at the origin because the
 * configured edge adapter would otherwise bypass request-time composition on HITs.
 */
export function shouldUseOriginManagedPageCache(): boolean {
  if (!isInsideUnifiedScope() || !getRequestContext().originManagedPageCache) return false;
  return cdnCacheAdapterBypassesOriginOnHit();
}

/** Page-artifact storage strategy for the current request. */
export function getCdnCacheStorageAdapter(): CdnCacheAdapter {
  if (shouldUseOriginManagedPageCache()) {
    return (_defaultAdapter ??= new DefaultCdnCacheAdapter());
  }
  return getCdnCacheAdapter();
}
