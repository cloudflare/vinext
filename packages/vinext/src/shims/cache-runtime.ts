/**
 * "use cache" runtime
 *
 * This module provides the runtime for "use cache" directive support.
 * Functions marked with "use cache" are transformed by the vinext:use-cache
 * Vite plugin to wrap them with `registerCachedFunction()`.
 *
 * The runtime:
 * 1. Generates a cache key from deployment/build ID + function identity + serialized arguments
 * 2. Checks the CacheHandler for a cached value
 * 3. On HIT: returns the cached value (deserialized via RSC stream)
 * 4. On MISS: creates an AsyncLocalStorage context for cacheLife/cacheTag,
 *    calls the original function, serializes the result via RSC stream,
 *    collects metadata, stores the result
 *
 * Serialization uses the RSC protocol (renderToReadableStream /
 * createFromReadableStream / encodeReply) from @vitejs/plugin-rsc.
 * This correctly handles React elements, client references, Promises,
 * and all RSC-serializable types — unlike JSON.stringify which silently
 * drops $$typeof Symbols and function values.
 *
 * When RSC APIs are unavailable (e.g. in unit tests), falls back to
 * JSON.stringify/parse with the same stableStringify cache key generation.
 *
 * Cache variants:
 * - "use cache"           — shared cache (default profile)
 * - "use cache: remote"   — shared cache (explicit)
 * - "use cache: private"  — per-request cache (not shared across requests)
 */

import {
  getDataCacheHandler,
  isBuiltInCacheHandler,
  type CachedFetchValue,
  type CacheControlMetadata,
  type CacheHandlerValue,
} from "./cache-handler.js";
import {
  cacheLifeProfiles,
  _hasPendingRevalidatedTag,
  _setRequestScopedCacheLife,
  _registerCacheContextAccessor,
  type CacheLifeConfig,
} from "./cache-request-state.js";
import { VINEXT_RSC_MARKER_HEADER } from "../server/headers.js";
import { addCollectedRequestTags, getCurrentFetchSoftTags } from "./fetch-cache.js";
import { getOrCreateAls } from "./internal/als-registry.js";
import {
  isInsideUnifiedScope,
  getRequestContext,
  runWithUnifiedStateMutation,
} from "./unified-request-context.js";
import { isDraftModeEnabled, markDynamicUsage } from "./headers.js";
import { trackPprFallbackShellCacheTask } from "./ppr-fallback-shell.js";
import { isMarkedAppPagePropsObject } from "./internal/app-page-props-cache-key.js";
import { getCurrentRootParams, type RootParams } from "./root-params.js";

export { markAppPagePropsForUseCache } from "./internal/app-page-props-cache-key.js";

// ---------------------------------------------------------------------------
// Constants for nested-dynamic cache life detection
// ---------------------------------------------------------------------------

/** Threshold below which expire is considered "dynamic" (5 minutes in seconds). */
const DYNAMIC_EXPIRE = 300;

/**
 * Used purely as `cause` for the nested-dynamic cache error: its captured stack
 * points at the inner "use cache" invocation that propagated a dynamic cache
 * life up to the outer cache. Constructed eagerly while the caller is still on
 * the synchronous stack.
 */
export class NestedDynamicUseCacheError extends Error {
  constructor() {
    super('This "use cache" has a dynamic cache life that was propagated to its parent.');
    this.name = 'Nested dynamic "use cache"';
  }
}

/**
 * Returns the human-readable phrase describing the current context for use in
 * nested-dynamic error messages. The throw is gated to fire only during the
 * build's prerender phase (`VINEXT_PRERENDER=1`) or development; this phrase
 * tells the user which one they're in so the message isn't misleading.
 *
 * `VINEXT_PRERENDER` takes priority over `NODE_ENV=development`: if the
 * prerender flag is set, the user really is prerendering regardless of
 * NODE_ENV (this matters for scenarios like a dev-config prerender). Defaults
 * to "during prerendering" to match Next.js wording when called from a
 * context we don't recognize (the throw also wouldn't fire in that case).
 */
function nestedCacheContextPhrase(): string {
  if (typeof process === "undefined") return "during prerendering";
  if (process.env.VINEXT_PRERENDER === "1") return "during prerendering";
  if (process.env.NODE_ENV === "development") return "in development";
  return "during prerendering";
}

function getNestedCacheZeroRevalidateErrorMessage(): string {
  const phrase = nestedCacheContextPhrase();
  return (
    `A "use cache" with zero \`revalidate\` is nested inside another "use cache" ` +
    `that has no explicit \`cacheLife\`, which is not allowed ${phrase}. ` +
    `Add \`cacheLife()\` to the outer "use cache" to choose ` +
    `whether it should be prerendered (with non-zero \`revalidate\`) or remain ` +
    `dynamic (with zero \`revalidate\`). Read more: ` +
    `https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife`
  );
}

function getNestedCacheShortExpireErrorMessage(): string {
  const phrase = nestedCacheContextPhrase();
  return (
    `A "use cache" with short \`expire\` (under 5 minutes) is nested inside ` +
    `another "use cache" that has no explicit \`cacheLife\`, which is not ` +
    `allowed ${phrase}. Add \`cacheLife()\` to the outer "use cache" ` +
    `to choose whether it should be prerendered (with longer \`expire\`) or remain ` +
    `dynamic (with short \`expire\`). Read more: ` +
    `https://nextjs.org/docs/messages/nested-use-cache-no-explicit-cachelife`
  );
}

// ---------------------------------------------------------------------------
// Cache execution context — AsyncLocalStorage for cacheLife/cacheTag
// ---------------------------------------------------------------------------

export type CacheContext = {
  /** Tags collected via cacheTag() during execution */
  tags: string[];
  /** Cache life configs collected via cacheLife() — minimum-wins rule applies */
  lifeConfigs: CacheLifeConfig[];
  /** Cache variant: "default" | "remote" | "private" */
  variant: string;
  /** Root params observed while producing this public cache entry. */
  readRootParamNames?: Set<string>;
  /** Whether cacheLife() was called with an explicit revalidate value */
  hasExplicitRevalidate: boolean;
  /** Whether cacheLife() was called with an explicit expire value */
  hasExplicitExpire: boolean;
  /**
   * The first nested public "use cache" invocation with a dynamic cache life
   * (revalidate === 0 or expire < DYNAMIC_EXPIRE) that propagated up to this
   * cache. Used as `cause` for the nested-dynamic cache error.
   */
  dynamicNestedCacheError: Error | undefined;
  /**
   * Dynamic request API error recorded inside this cache scope. This persists
   * even if user code catches the original throw, so the wrapper can avoid
   * storing request-specific output under a shared cache key.
   */
  invalidDynamicUsageError?: unknown;
};

// Store on globalThis via Symbol so headers.ts can detect "use cache" scope
// without a direct import (avoiding circular dependencies).
export const cacheContextStorage = getOrCreateAls<CacheContext>("vinext.cacheRuntime.contextAls");

// Register the context accessor so cacheLife()/cacheTag() in cache.ts can
// access the context without a circular import.
_registerCacheContextAccessor(() => cacheContextStorage.getStore() ?? null);

/**
 * Get the current cache context. Returns null if not inside a "use cache" function.
 */
export function getCacheContext(): CacheContext | null {
  return cacheContextStorage.getStore() ?? null;
}

// ---------------------------------------------------------------------------
// Lazy RSC module loading
// ---------------------------------------------------------------------------

/**
 * RSC serialization APIs from @vitejs/plugin-rsc/react/rsc.
 * Lazily loaded because these are only available in the Vite RSC environment
 * (they depend on virtual modules set up by @vitejs/plugin-rsc).
 * In test environments, the import fails and we fall back to JSON.
 */
type RscModule = {
  renderToReadableStream: (data: unknown, options?: object) => ReadableStream<Uint8Array>;
  createFromReadableStream: <T>(
    stream: ReadableStream<Uint8Array>,
    options?: object,
    context?: { preserveServerReferences?: boolean },
  ) => Promise<T>;
  encodeReply: (v: unknown[], options?: unknown) => Promise<string | FormData>;
  createTemporaryReferenceSet: () => unknown;
  createClientTemporaryReferenceSet: () => unknown;
  decodeReply: (body: string | FormData, options?: unknown) => Promise<unknown[]>;
};

type SerializedCacheResult = {
  body: string;
  headers: Record<string, string>;
};

function getUseCacheDeploymentIdDefine(): string | undefined {
  try {
    // Keep this direct reference so Vite's define transform can inline it for
    // Worker bundles where the process global might not exist at runtime.
    return process.env.__VINEXT_DEPLOYMENT_ID || process.env.NEXT_DEPLOYMENT_ID;
  } catch (error) {
    if (error instanceof ReferenceError) return undefined;
    throw error;
  }
}

function getUseCacheBuildIdDefine(): string | undefined {
  try {
    // Keep this direct reference so Vite's define transform can inline it for
    // Worker bundles where the process global might not exist at runtime.
    return process.env.__VINEXT_BUILD_ID;
  } catch (error) {
    if (error instanceof ReferenceError) return undefined;
    throw error;
  }
}

function getUseCacheKeySeed(): string | undefined {
  return getUseCacheDeploymentIdDefine() || getUseCacheBuildIdDefine();
}

/**
 * Build the shared-cache key for a "use cache" function from its build-scoped
 * identity and serialized arguments.
 *
 * This is a logical handler key, not a storage key. Backend-specific adapters
 * are responsible for mapping it to their physical key constraints after
 * applying any storage prefixes.
 *
 * Exported for testing.
 */
export function buildUseCacheKey(
  id: string,
  keySeed: string | undefined,
  argsKey?: string,
): string {
  const scopedId = keySeed ? `build:${encodeURIComponent(keySeed)}:${id}` : id;
  return argsKey === undefined ? `use-cache:${scopedId}` : `use-cache:${scopedId}:${argsKey}`;
}

const NOT_LOADED = Symbol("not-loaded");
let _rscModule: RscModule | null | typeof NOT_LOADED = NOT_LOADED;

async function getRscModule(): Promise<RscModule | null> {
  if (_rscModule !== NOT_LOADED) return _rscModule;
  try {
    _rscModule = (await import("@vitejs/plugin-rsc/react/rsc")) as RscModule;
  } catch {
    _rscModule = null;
  }
  return _rscModule;
}

// ---------------------------------------------------------------------------
// RSC stream helpers
// ---------------------------------------------------------------------------

/** Collect a ReadableStream<Uint8Array> into a single Uint8Array. */
async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalLength += value.length;
  }
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Encode a Uint8Array as a base64 string for storage. Uses Node Buffer. */
function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Decode a base64 string back to Uint8Array. Uses Node Buffer. */
function base64ToUint8(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Create a ReadableStream from a Uint8Array. */
function uint8ToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function serializeCacheResult(
  result: unknown,
  rsc: RscModule | null,
): Promise<SerializedCacheResult | null> {
  try {
    if (rsc) {
      // Draining the stream is part of cache entry generation: lazy Server
      // Components may execute here and contribute tags, cache life, or root
      // param dependencies to the active cache scope.
      const stream = rsc.renderToReadableStream(result);
      const bytes = await collectStream(stream);
      return {
        body: uint8ToBase64(bytes),
        headers: { [VINEXT_RSC_MARKER_HEADER]: "1" },
      };
    }

    const body = JSON.stringify(result);
    return body === undefined ? null : { body, headers: {} };
  } catch {
    return null;
  }
}

/**
 * Convert an encodeReply result (string | FormData) to a cache key string.
 * For FormData (binary args), produces a deterministic SHA-256 hash over
 * the sorted entries. We can't hash `new Response(formData).arrayBuffer()`
 * because multipart boundaries are non-deterministic across serializations.
 *
 * Exported for testing.
 */
export async function replyToCacheKey(reply: string | FormData): Promise<string> {
  if (typeof reply === "string") return reply;

  // Collect entries in stable order (sorted by name, then by value for
  // entries with the same name) so the hash is deterministic.
  const entries: [string, FormDataEntryValue][] = [...reply.entries()];
  const valStr = (v: FormDataEntryValue): string => (typeof v === "string" ? v : v.name);
  entries.sort((a, b) => a[0].localeCompare(b[0]) || valStr(a[1]).localeCompare(valStr(b[1])));

  const parts: string[] = [];
  for (const [name, value] of entries) {
    if (typeof value === "string") {
      parts.push(`${name}=s:${value}`);
    } else {
      // Blob/File: include type, size, and content bytes
      const bytes = new Uint8Array(await value.arrayBuffer());
      parts.push(`${name}=b:${value.type}:${value.size}:${Buffer.from(bytes).toString("base64")}`);
    }
  }

  const payload = new TextEncoder().encode(parts.join("\0"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", payload);
  return Buffer.from(new Uint8Array(hashBuffer)).toString("base64url");
}

// ---------------------------------------------------------------------------
// Minimum-wins resolution for cacheLife
// ---------------------------------------------------------------------------

/**
 * Resolve collected cacheLife configs into a single effective config.
 * The "minimum-wins" rule: if multiple cacheLife() calls are made,
 * each field takes the smallest value across all calls.
 */
function resolveCacheLife(configs: CacheLifeConfig[]): CacheLifeConfig {
  if (configs.length === 0) {
    // Default profile
    return { ...cacheLifeProfiles.default };
  }

  if (configs.length === 1) {
    return { ...configs[0] };
  }

  // Minimum-wins across all fields
  const result: CacheLifeConfig = {};

  for (const config of configs) {
    if (config.stale !== undefined) {
      result.stale =
        result.stale !== undefined ? Math.min(result.stale, config.stale) : config.stale;
    }
    if (config.revalidate !== undefined) {
      result.revalidate =
        result.revalidate !== undefined
          ? Math.min(result.revalidate, config.revalidate)
          : config.revalidate;
    }
    if (config.expire !== undefined) {
      result.expire =
        result.expire !== undefined ? Math.min(result.expire, config.expire) : config.expire;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Request-scoped invocation state
// Uses AsyncLocalStorage for request isolation so concurrent requests on
// Workers never share pending or completed cache-function invocations.
// ---------------------------------------------------------------------------
type CacheInvocationMetadata = {
  tags: string[];
  cacheLife?: CacheLifeConfig;
  rootParamNames?: Set<string>;
  variant: string;
};

type CacheInvocationResult = {
  result: unknown;
  metadata: CacheInvocationMetadata;
};

export type CacheInvocationState = {
  pendingCacheInvocations: Map<string, Promise<CacheInvocationResult>> | null;
  completedCacheInvocations: Map<string, Promise<CacheInvocationResult>> | null;
};

// Keep the registry identifiers stable across HMR and separately bundled Vite
// environments; the state they point to now contains invocation maps only.
const _INVOCATION_FALLBACK_KEY = Symbol.for("vinext.cacheRuntime.privateFallback");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;
const _invocationAls = getOrCreateAls<CacheInvocationState>("vinext.cacheRuntime.privateAls");

const _invocationFallbackState = (_g[_INVOCATION_FALLBACK_KEY] ??= {
  pendingCacheInvocations: new Map<string, Promise<CacheInvocationResult>>(),
  completedCacheInvocations: new Map<string, Promise<CacheInvocationResult>>(),
} satisfies CacheInvocationState) as CacheInvocationState;
_invocationFallbackState.pendingCacheInvocations ??= new Map();
_invocationFallbackState.completedCacheInvocations ??= new Map();

function _getInvocationState(): CacheInvocationState {
  if (isInsideUnifiedScope()) {
    const ctx = getRequestContext();
    ctx.pendingCacheInvocations ??= new Map();
    ctx.completedCacheInvocations ??= new Map();
    return ctx;
  }
  return _invocationAls.getStore() ?? _invocationFallbackState;
}

function _getRequestScopedInvocationState(cacheVariant: string): CacheInvocationState | null {
  if (isInsideUnifiedScope()) return _getInvocationState();

  const invocationState = _invocationAls.getStore();
  if (invocationState) return invocationState;

  // Preserve the legacy direct-call behavior of "use cache: private", but do
  // not retain public invocations in process-global fallback state. Public
  // invocation maps are meaningful only when a request scope owns them.
  return cacheVariant === "private" ? _invocationFallbackState : null;
}

/**
 * Run a function within a request-scoped cache invocation ALS scope.
 * The legacy export name is retained for generated Pages Router entries.
 */
export function runWithPrivateCache<T>(fn: () => Promise<T>): Promise<T>;
export function runWithPrivateCache<T>(fn: () => T | Promise<T>): T | Promise<T>;
export function runWithPrivateCache<T>(fn: () => T | Promise<T>): T | Promise<T> {
  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.pendingCacheInvocations = new Map();
      uCtx.completedCacheInvocations = new Map();
    }, fn);
  }
  const state: CacheInvocationState = {
    pendingCacheInvocations: new Map(),
    completedCacheInvocations: new Map(),
  };
  return _invocationAls.run(state, fn);
}

/**
 * Clear request-scoped cache invocations. Only needed when not using
 * runWithPrivateCache() (legacy path); the export name is retained for
 * compatibility with existing callers.
 */
export function clearPrivateCache(): void {
  if (isInsideUnifiedScope()) {
    const context = getRequestContext();
    context.pendingCacheInvocations = new Map();
    context.completedCacheInvocations = new Map();
    return;
  }
  const state = _invocationAls.getStore();
  if (state) {
    state.pendingCacheInvocations = new Map();
    state.completedCacheInvocations = new Map();
  } else {
    _invocationFallbackState.pendingCacheInvocations = new Map();
    _invocationFallbackState.completedCacheInvocations = new Map();
  }
}

// ---------------------------------------------------------------------------
// Root-param-aware shared cache keys
// ---------------------------------------------------------------------------

const ROOT_PARAM_REDIRECT_HEADER = "x-vinext-use-cache-root-params";
const ROOT_PARAM_TAG_PREFIX = "__vinext_use_cache_root_param__:";
const _KNOWN_ROOT_PARAMS_KEY = Symbol.for("vinext.cacheRuntime.knownRootParamsByFunctionId");

const knownRootParamsByFunctionId = (_g[_KNOWN_ROOT_PARAMS_KEY] ??= new Map<
  string,
  Set<string>
>()) as Map<string, Set<string>>;

function addKnownRootParamNames(id: string, names: ReadonlySet<string>): Set<string> {
  const known = knownRootParamsByFunctionId.get(id);
  if (known) {
    for (const name of names) known.add(name);
    return known;
  }
  const created = new Set(names);
  knownRootParamsByFunctionId.set(id, created);
  return created;
}

function computeRootParamsCacheKeySuffix(
  rootParams: RootParams,
  paramNames: ReadonlySet<string>,
): string {
  if (paramNames.size === 0) return "";
  return `:root-params:${JSON.stringify(
    [...paramNames].sort().map((name) => [name, rootParams[name]]),
  )}`;
}

function rootParamNamesFromTags(tags: readonly string[] | undefined): Set<string> {
  const names = new Set<string>();
  for (const tag of tags ?? []) {
    if (tag.startsWith(ROOT_PARAM_TAG_PREFIX)) {
      names.add(tag.slice(ROOT_PARAM_TAG_PREFIX.length));
    }
  }
  return names;
}

function isRootParamRedirect(entry: CacheHandlerValue | null): boolean {
  return (
    entry?.value?.kind === "FETCH" && entry.value.data.headers[ROOT_PARAM_REDIRECT_HEADER] === "1"
  );
}

function propagateRootParamNamesToParent(names: ReadonlySet<string> | undefined): void {
  if (!names || names.size === 0) return;
  const parent = cacheContextStorage.getStore();
  if (!parent || parent.variant === "private") return;
  for (const name of names) parent.readRootParamNames?.add(name);
}

// ---------------------------------------------------------------------------
// Core runtime: registerCachedFunction
// ---------------------------------------------------------------------------

export type RegisterCachedFunctionOptions = {
  /**
   * Whether the original function declaration accepts a second argument.
   * Function.length cannot represent default or rest parameters, so the
   * transform records this separately for metadata parent resolution.
   */
  acceptsSecondArgument?: boolean;
  /**
   * Internal transform metadata for file-level `"use cache"` default exports
   * in App Router `page.*` files. Page components receive framework-owned
   * `{ params, searchParams }` props. React may copy that props object before
   * invocation, so this invariant must live at the cached function boundary
   * rather than on the intermediate createElement config object.
   */
  appPageDefaultExport?: boolean;
  /** Number of declared arguments supplied by the directive transform. */
  argumentCount?: number;
  decryptCaptures?: (value: unknown) => Promise<unknown[] | undefined>;
};

/**
 * Register a function as a cached function. This is called by the Vite
 * transform for each "use cache" function.
 *
 * @param fn - The original async function
 * @param id - A stable identifier for the function (module path + export name)
 * @param variant - Cache variant: "" (default/shared), "remote", "private"
 * @returns A wrapper function that checks cache before calling the original
 */
export function registerCachedFunction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  id: string,
  variant?: string,
  options: RegisterCachedFunctionOptions = {},
): (...args: TArgs) => Promise<TResult> {
  const cacheVariant = variant ?? "";
  const omitAppPageSearchParamsFromFirstArg = options.appPageDefaultExport === true;

  // In dev mode, skip the shared cache so code changes are immediately
  // visible after HMR. Without this, the MemoryCacheHandler returns stale
  // results because the cache key (module path + export name) doesn't
  // change when the file is edited — only the function body changes.
  // Per-request ("use cache: private") caching still works in dev since
  // it's scoped to a single request and doesn't persist across HMR.
  const isDev = typeof process !== "undefined" && process.env.NODE_ENV === "development";

  const cachedFn = (...args: TArgs): Promise<TResult> =>
    trackPprFallbackShellCacheTask(async (): Promise<TResult> => {
      const rsc = await getRscModule();
      const keySeed = getUseCacheKeySeed();
      const captures = options.decryptCaptures ? await options.decryptCaptures(args[0]) : undefined;
      const hasCaptureEnvelope = captures !== undefined;
      const admittedArgs =
        options.argumentCount === undefined
          ? args
          : hasCaptureEnvelope
            ? [args[0], ...args.slice(1, 1 + options.argumentCount)]
            : args.slice(0, options.argumentCount);
      const executionArgs = hasCaptureEnvelope
        ? [captures, ...admittedArgs.slice(1)]
        : admittedArgs;
      const callArgs = executionArgs as TArgs;

      // Build the cache key. Use encodeReply (RSC protocol) when available —
      // it correctly handles React elements as temporary references (excluded
      // from key). Falls back to stableStringify when RSC is unavailable.
      let cacheKey: string;
      try {
        const processedArgs =
          executionArgs.length > 0
            ? unwrapThenableObjectArray(executionArgs, { omitAppPageSearchParamsFromFirstArg })
            : [];
        if (rsc && executionArgs.length > 0) {
          // Temporary references let encodeReply handle non-serializable values
          // (like React elements in args) by excluding them from the key.
          const tempRefs = rsc.createClientTemporaryReferenceSet();
          // Unwrap Promise-augmented objects before encoding.
          // Next.js 16 params/searchParams are created via
          // Object.assign(Promise.resolve(obj), obj) — a Promise with own
          // enumerable properties. encodeReply treats Promises as temporary
          // references (excluded from the key), which means different param
          // values (e.g., section:"sports" vs section:"electronics") produce
          // identical cache keys. We must extract the plain data so the actual
          // values are included in the cache key.
          const encoded = await rsc.encodeReply(processedArgs, {
            temporaryReferences: tempRefs,
          });
          cacheKey = buildUseCacheKey(id, keySeed, await replyToCacheKey(encoded));
        } else {
          const argsKey = processedArgs.length > 0 ? stableStringify(processedArgs) : undefined;
          cacheKey = buildUseCacheKey(id, keySeed, argsKey);
        }
      } catch {
        // Non-serializable arguments — run without caching
        return fn(...callArgs);
      }

      const isPrivate = cacheVariant === "private";
      if (isPrivate) {
        const parentCtx = cacheContextStorage.getStore();
        if (parentCtx && parentCtx.variant !== "private") {
          throwPrivateUseCacheInsidePublicUseCacheError();
        }

        if (typeof process !== "undefined" && process.env.VINEXT_PRERENDER === "1") {
          // Next.js treats "use cache: private" as dynamic during prerendering:
          // it is excluded from the static artifact and resolved per request.
          // https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-wrapper.ts
          markDynamicUsage();
        }
      }

      // Draft mode joins dev in skipping shared cache lookup/storage: the key
      // covers function id, build seed and arguments but not draft state, so a
      // preview request would otherwise seed unpublished content into an entry
      // later served to public requests. Mirrors Next.js's `isDraftMode` guard.
      const bypassSharedCache = !isPrivate && (isDev || isDraftModeEnabled());
      const handler = isPrivate || bypassSharedCache ? null : getDataCacheHandler();
      const softTags = isPrivate ? [] : getCurrentFetchSoftTags();
      const invocationState = _getRequestScopedInvocationState(cacheVariant);
      const pendingInvocations = invocationState?.pendingCacheInvocations;
      const completedInvocations = invocationState?.completedCacheInvocations;

      // Concurrent callers always join the in-flight invocation. The leader
      // owns the handler lookup and fill, so a joiner must not repeat discard
      // checks against a value that has not finished being produced yet.
      const pendingInvocation = pendingInvocations?.get(cacheKey);
      if (pendingInvocation) {
        const invocation = await pendingInvocation;
        applyJoinedInvocationMetadata(invocation.metadata);
        return invocation.result as TResult;
      }

      // Completed entries are stored values rather than in-flight work. Reuse
      // them only when this call is not bypassing the shared cache and no tag
      // used by the entry (including path-derived soft tags) was invalidated
      // earlier in this request.
      if (!bypassSharedCache) {
        const completedInvocation = completedInvocations?.get(cacheKey);
        if (completedInvocation) {
          const invocation = await completedInvocation;
          if (_hasPendingRevalidatedTag([...invocation.metadata.tags, ...softTags])) {
            completedInvocations?.delete(cacheKey);
          } else {
            applyJoinedInvocationMetadata(invocation.metadata);
            return invocation.result as TResult;
          }
        }
      }

      // Defer the leader by one microtask so its promise can be installed in
      // the pending map before the original function starts. This also covers
      // synchronous re-entry from the function body.
      const invocationPromise = Promise.resolve().then(async (): Promise<CacheInvocationResult> => {
        if (isPrivate || bypassSharedCache) {
          const { result, ctx, effectiveLife } = await runCachedFunctionWithContext(
            fn,
            callArgs,
            cacheVariant,
          );
          recordRequestScopedCacheLife(effectiveLife);
          return {
            result,
            metadata: {
              tags: [...ctx.tags],
              cacheLife: effectiveLife,
              rootParamNames:
                !isPrivate && ctx.readRootParamNames && ctx.readRootParamNames.size > 0
                  ? new Set(ctx.readRootParamNames)
                  : undefined,
              variant: cacheVariant,
            },
          };
        }

        // Shared cache ("use cache" / "use cache: remote")
        // handler is non-null because private and bypass paths returned above.
        const sharedHandler = handler!;
        const rootParams = getCurrentRootParams();
        const knownRootParamNames = knownRootParamsByFunctionId.get(id);
        const coarseCacheKey = cacheKey;
        let handlerCacheKey = coarseCacheKey;
        if (knownRootParamNames && rootParams) {
          handlerCacheKey += computeRootParamsCacheKeySuffix(rootParams, knownRootParamNames);
        }

        // Check cache — deserialize via RSC stream when available, JSON otherwise.
        // Pass soft tags so that revalidatePath() / revalidateTag() invalidation
        // applies to "use cache" entries even when the entry carries no hard tags.
        // The soft tags are path-derived implicit tags set by the enclosing route
        // handler or page dispatch — see setCurrentFetchSoftTags in fetch-cache.ts.
        // A handler failure (e.g. a transient KV error, or a key the store
        // rejects) must not surface as a render error: fall through to fresh
        // execution so control-flow signals like notFound()/redirect() thrown by
        // `fn` still propagate with their digest intact instead of being masked
        // by the handler's own exception.
        let existing: CacheHandlerValue | null = null;
        if (!_hasPendingRevalidatedTag(softTags)) {
          try {
            existing = await sharedHandler.get(handlerCacheKey, { kind: "FETCH", softTags });
          } catch (error) {
            console.error(
              "[vinext] use cache: handler.get failed; treating as a cache miss:",
              error,
            );
          }
        }
        const redirectValue = existing?.value;
        if (
          isRootParamRedirect(existing) &&
          existing?.cacheState !== "stale" &&
          rootParams &&
          redirectValue?.kind === "FETCH" &&
          !_hasPendingRevalidatedTag([...(redirectValue.tags ?? []), ...softTags])
        ) {
          const redirectNames = rootParamNamesFromTags(redirectValue.tags);
          const combinedNames = addKnownRootParamNames(id, redirectNames);
          handlerCacheKey =
            coarseCacheKey + computeRootParamsCacheKeySuffix(rootParams, combinedNames);
          try {
            existing = await sharedHandler.get(handlerCacheKey, { kind: "FETCH", softTags });
          } catch (error) {
            console.error(
              "[vinext] use cache: handler.get failed; treating as a cache miss:",
              error,
            );
            existing = null;
          }
        }
        if (
          existing?.value &&
          existing.value.kind === "FETCH" &&
          existing.cacheState !== "stale" &&
          !_hasPendingRevalidatedTag([...(existing.value.tags ?? []), ...softTags])
        ) {
          try {
            const rootParamNames = knownRootParamsByFunctionId.get(id);
            propagateRootParamNamesToParent(rootParamNames);
            // Surface the cached entry's tags to the surrounding request so the
            // enclosing page / route-handler ISR entry carries them even on a data
            // cache HIT — otherwise `revalidateTag()` could not evict the rendered
            // output that embeds this cached value (issue #1453).
            propagateCacheTagsToRequest(existing.value.tags);
            let result: TResult;
            if (rsc && existing.value.data.headers[VINEXT_RSC_MARKER_HEADER] === "1") {
              // RSC-serialized entry: base64 → bytes → stream → deserialize
              const bytes = base64ToUint8(existing.value.data.body);
              const stream = uint8ToStream(bytes);
              result = await rsc.createFromReadableStream<TResult>(
                stream,
                {},
                { preserveServerReferences: true },
              );
            } else {
              // JSON-serialized entry (legacy or no RSC available)
              result = JSON.parse(existing.value.data.body) as TResult;
            }
            recordRequestScopedCacheControl(existing.cacheControl);
            return {
              result,
              metadata: {
                tags: [...(existing.value.tags ?? [])],
                cacheLife: cacheControlToCacheLife(existing.cacheControl),
                rootParamNames: rootParamNames ? new Set(rootParamNames) : undefined,
                variant: cacheVariant,
              },
            };
          } catch {
            // Corrupted entry, fall through to re-execute
          }
        }

        // Cache miss (or stale) — execute with context
        const { result, ctx, effectiveLife, collectedResult } = await runCachedFunctionWithContext(
          fn,
          callArgs,
          cacheVariant,
          (value) => serializeCacheResult(value, rsc),
        );

        const rootParamNames =
          ctx.readRootParamNames && ctx.readRootParamNames.size > 0
            ? addKnownRootParamNames(id, ctx.readRootParamNames)
            : knownRootParamsByFunctionId.get(id);

        recordRequestScopedCacheLife(effectiveLife);
        // Bubble the cache scope's tags up to the surrounding request so the
        // enclosing page / route-handler ISR entry is tagged for on-demand
        // revalidation (issue #1453). `ctx.tags` already includes any nested
        // child cache's tags via `runCachedFunctionWithContext`.
        propagateCacheTagsToRequest(ctx.tags);
        const revalidateSeconds =
          effectiveLife.revalidate ?? cacheLifeProfiles.default.revalidate ?? 900;

        // Serialization ran while the cache ALS was active so lazy Server
        // Component work is reflected in `ctx` before selecting the final key.
        if (collectedResult) {
          try {
            const cacheValue = {
              kind: "FETCH",
              data: {
                headers: collectedResult.headers,
                body: collectedResult.body,
                url: handlerCacheKey,
              },
              tags: ctx.tags,
              revalidate: revalidateSeconds,
            } satisfies CachedFetchValue;
            const cacheContext = {
              fetchCache: true,
              tags: ctx.tags,
              cacheControl: {
                revalidate: revalidateSeconds,
                expire: effectiveLife.expire,
                // Persisted so a later hit re-registers the same claim; otherwise
                // the enclosing render's minimum depends on cache temperature.
                stale: effectiveLife.stale,
              },
            };

            if (rootParamNames && rootParamNames.size > 0 && rootParams) {
              const specificCacheKey =
                coarseCacheKey + computeRootParamsCacheKeySuffix(rootParams, rootParamNames);
              const redirectTags = [
                ...ctx.tags,
                ...[...rootParamNames].map((name) => ROOT_PARAM_TAG_PREFIX + name),
              ];
              await sharedHandler.set(
                coarseCacheKey,
                {
                  kind: "FETCH",
                  data: {
                    headers: { [ROOT_PARAM_REDIRECT_HEADER]: "1" },
                    body: "",
                    url: coarseCacheKey,
                  },
                  tags: redirectTags,
                  revalidate: revalidateSeconds,
                },
                { ...cacheContext, tags: redirectTags },
              );
              // Write the useful entry last. A bounded LRU that can retain only
              // one of the pair must keep the specific value, not the redirect.
              cacheValue.data.url = specificCacheKey;
              await sharedHandler.set(specificCacheKey, cacheValue, cacheContext);
            } else {
              await sharedHandler.set(handlerCacheKey, cacheValue, cacheContext);
            }
          } catch {
            // A handler failure skips caching but must not fail the render.
          }
        }

        return {
          result,
          metadata: {
            tags: [...ctx.tags],
            cacheLife: effectiveLife,
            rootParamNames: rootParamNames ? new Set(rootParamNames) : undefined,
            variant: cacheVariant,
          },
        };
      });

      pendingInvocations?.set(cacheKey, invocationPromise);

      try {
        const invocation = await invocationPromise;
        if (isPrivate || (handler !== null && !isBuiltInCacheHandler(handler))) {
          completedInvocations?.set(cacheKey, invocationPromise);
        }
        return invocation.result as TResult;
      } finally {
        if (pendingInvocations?.get(cacheKey) === invocationPromise) {
          pendingInvocations.delete(cacheKey);
        }
      }
    }, cacheVariant);

  // Preserve the original function's arity on the wrapper. The wrapper is
  // declared as `(...args)` (arity 0), which hides the original signature.
  // Callers like `resolveModuleMetadata` rely on `fn.length` to decide whether
  // to pass optional arguments (e.g. the `parent` metadata) — matching Next.js,
  // which omits the `parent` argument when a cached `generateMetadata` does not
  // declare/use it, so non-serializable parent values (like a `URL`
  // `metadataBase`) never reach the cache-key encoder.
  // Function `length` is always `configurable: true` per spec, so this is safe.
  Object.defineProperty(cachedFn, "length", { value: fn.length, configurable: true });

  // Tag the wrapper so callers (e.g. the OTel tracer extension) can detect
  // that this is a "use cache" function without relying on React server
  // reference internals.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cachedFn as any)[USE_CACHE_FUNCTION_SYMBOL] = true;

  if (options.acceptsSecondArgument !== undefined) {
    Reflect.set(cachedFn, USE_CACHE_ACCEPTS_SECOND_ARGUMENT_SYMBOL, options.acceptsSecondArgument);
  }

  return cachedFn;
}

/** @internal Symbol used to identify "use cache" wrapper functions. */
const USE_CACHE_FUNCTION_SYMBOL = Symbol.for("vinext.useCacheFunction");
/** @internal Symbol carrying transform-derived cached function argument metadata. */
const USE_CACHE_ACCEPTS_SECOND_ARGUMENT_SYMBOL = Symbol.for("vinext.useCacheAcceptsSecondArgument");

function throwPrivateUseCacheInsidePublicUseCacheError(): never {
  const error = new Error(
    '"use cache: private" must not be used within "use cache". It can only be nested inside of another "use cache: private".',
  );
  const ctx = getRequestContext();
  if (ctx) ctx.invalidDynamicUsageError = error;
  throw error;
}

function cacheControlToCacheLife(
  cacheControl: CacheControlMetadata | undefined,
): CacheLifeConfig | undefined {
  if (cacheControl === undefined) return undefined;
  return {
    // `false` is an indefinite lifetime and does not constrain the enclosing
    // scope's finite revalidation window.
    revalidate: cacheControl.revalidate === false ? undefined : cacheControl.revalidate,
    expire: cacheControl.expire,
    stale: cacheControl.stale,
  };
}

function recordRequestScopedCacheControl(cacheControl: CacheControlMetadata | undefined): void {
  const life = cacheControlToCacheLife(cacheControl);
  if (life === undefined) return;
  // A hit must contribute the same claim its producing execution did — both to
  // the request scope and, when nested, to the enclosing cache scope (like the
  // MISS path's `parentCtx.lifeConfigs.push`); otherwise the inner claim
  // vanishes once the outer entry goes warm.
  const parentCtx = cacheContextStorage.getStore();
  parentCtx?.lifeConfigs.push(life);

  // A warm nested HIT must preserve the same dynamic-cache validation as the
  // MISS that produced it. The persisted cache-control fields already contain
  // the values Next.js checks at the cache read site, so derive the signal
  // from them instead of extending the stored payload. Capture the current
  // inner-cache call site while it is still on the stack; the enclosing scope
  // later applies its explicit cacheLife suppression exactly as on a MISS.
  if (
    parentCtx &&
    parentCtx.variant !== "private" &&
    (life.revalidate === 0 || (life.expire !== undefined && life.expire < DYNAMIC_EXPIRE))
  ) {
    const error = new NestedDynamicUseCacheError();
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(error, recordRequestScopedCacheControl);
    }
    parentCtx.dynamicNestedCacheError ??= error;
  }
  _setRequestScopedCacheLife(life);
}

function recordRequestScopedCacheLife(cacheLife: CacheLifeConfig): void {
  _setRequestScopedCacheLife(cacheLife);
}

function applyJoinedInvocationMetadata(metadata: CacheInvocationMetadata): void {
  const parentCtx = cacheContextStorage.getStore();

  if (metadata.rootParamNames) {
    propagateRootParamNamesToParent(metadata.rootParamNames);
  }

  // A top-level private entry has no persistent cache to invalidate, matching
  // the leader path. Nested private entries still need to bubble tags into
  // their enclosing private cache context.
  if (metadata.variant !== "private" || parentCtx) {
    propagateCacheTagsToRequest(metadata.tags);
  }

  const cacheLife = metadata.cacheLife;
  if (cacheLife === undefined) return;

  // The leader's runCachedFunctionWithContext call already performed this
  // propagation. A joiner executes in its own enclosing cache context, so it
  // must replay the same metadata there as a normal hit would.
  parentCtx?.lifeConfigs.push(cacheLife);
  if (
    parentCtx &&
    parentCtx.variant !== "private" &&
    metadata.variant !== "private" &&
    (cacheLife.revalidate === 0 ||
      (cacheLife.expire !== undefined && cacheLife.expire < DYNAMIC_EXPIRE))
  ) {
    const error = new NestedDynamicUseCacheError();
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(error, applyJoinedInvocationMetadata);
    }
    parentCtx.dynamicNestedCacheError ??= error;
  }

  recordRequestScopedCacheLife(cacheLife);
}

/**
 * Bubble a `"use cache"` scope's tags toward where they can drive invalidation.
 *
 * When this cache is nested inside another (`parentCtx` present), the tags flow
 * into the parent scope so they end up on the outer cache entry — mirroring
 * Next.js's `propagateCacheLifeAndTagsToRevalidateStore`. The outermost scope
 * (no parent) instead records onto the surrounding request's collected tags, so
 * the enclosing page / route-handler ISR entry carries them and `revalidateTag`
 * can evict the rendered output (issue #1453).
 *
 * Used by both the data cache HIT and MISS paths. On MISS the parent-bubble for
 * the *executed* scope also happens in `runCachedFunctionWithContext`; this keeps
 * the HIT path (where that function never runs) correct without dropping a nested
 * inner entry's stored tags. Deduped to keep tag lists tidy.
 */
function propagateCacheTagsToRequest(tags: readonly string[] | undefined): void {
  if (!tags || tags.length === 0) return;
  const parentCtx = cacheContextStorage.getStore();
  if (parentCtx) {
    for (const tag of tags) {
      if (!parentCtx.tags.includes(tag)) {
        parentCtx.tags.push(tag);
      }
    }
    return;
  }
  addCollectedRequestTags(tags);
}

/**
 * Core helper that runs a cached function with context, handles nested-dynamic
 * cache-life error propagation, and calls an optional post-execution callback.
 *
 * When the current execution is nested inside another public "use cache",
 * we eagerly capture a NestedDynamicUseCacheError at the entry point. After
 * execution, if the inner resolved a dynamic cache life (revalidate === 0 or
 * expire < DYNAMIC_EXPIRE), we propagate the captured error to the outer
 * context. If this (outer) cache itself lacks an explicit cacheLife for the
 * relevant dynamic field, we throw the appropriate nested-dynamic error with
 * the inner's stack as `cause`.
 *
 * Callers and propagation paths:
 * - Shared cache MISS (`registerCachedFunction`, production): allocates the
 *   eager error only when the inner is nested inside a public parent, and
 *   propagates lifeConfigs/dynamicNestedCacheError up to the parent.
 * - Private variant (`"use cache: private"`): the variant is excluded from
 *   being a *parent* that throws (see the `parentCtx.variant !== "private"`
 *   guard below). Entry into a private cache from a public parent is rejected
 *   earlier to prevent request data from flowing into a shared cache entry.
 * - Dev mode (`registerCachedFunction`, NODE_ENV=development): skips the
 *   shared cache and executes through this helper directly.
 *
 * In all three paths, `recordRequestScopedCacheLife(effectiveLife)` is called
 * by `registerCachedFunction` after this helper returns.
 * The request-scoped store uses minimum-wins accumulation, so the order of
 * inner-vs-outer recording does not affect correctness — the final request
 * stale/revalidate/expire is the min across all caches encountered.
 */
type CachedFunctionResult<T, TCollected> = {
  result: T;
  ctx: CacheContext;
  effectiveLife: CacheLifeConfig;
  collectedResult: TCollected | undefined;
};

async function runCachedFunctionWithContext<
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  T extends (...args: any[]) => Promise<any>,
  TCollected = never,
>(
  fn: T,
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  variant: string,
  collectResult?: (result: Awaited<ReturnType<T>>, context: CacheContext) => Promise<TCollected>,
): Promise<CachedFunctionResult<Awaited<ReturnType<T>>, TCollected>> {
  const parentCtx = cacheContextStorage.getStore();

  // Eagerly capture an error at the call site if we're inside a public cache.
  // Private parents are intentionally excluded — "use cache: private" is
  // dynamic-by-definition and never triggers the throw upstream.
  //
  // `Error.captureStackTrace` is a V8-specific API (Node.js, Cloudflare
  // Workers, Chrome). It is guarded for robustness in case vinext is ever
  // run under a non-V8 runtime (e.g. JavaScriptCore in Bun); the `super()`
  // call in the `Error` constructor already captures a stack — the
  // captureStackTrace call just trims the constructor frame.
  //
  // Performance note: this allocation runs for every nested public cache
  // call, including those where the inner ultimately resolves a non-dynamic
  // cache life — in which case the error is silently discarded later. This
  // matches Next.js, which captures eagerly so the resulting `cause` points
  // at the original `"use cache"` call site rather than the post-execution
  // detection point. If a future profile ever shows this as a hot-path
  // bottleneck for cache-heavy workloads, switching to a lazy capture would
  // be the optimization — at the cost of less useful stack frames.
  let eagerError: Error | undefined;
  if (parentCtx && parentCtx.variant !== "private") {
    eagerError = new NestedDynamicUseCacheError();
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(eagerError, runCachedFunctionWithContext);
    }
  }

  const ctx: CacheContext = {
    tags: [],
    lifeConfigs: [],
    variant: variant || "default",
    readRootParamNames: new Set(),
    hasExplicitRevalidate: false,
    hasExplicitExpire: false,
    dynamicNestedCacheError: undefined,
    invalidDynamicUsageError: undefined,
  };

  let collectedResult: TCollected | undefined;
  const result = await cacheContextStorage.run(ctx, async () => {
    const value = await fn(...args);
    if (collectResult) {
      collectedResult = await collectResult(value, ctx);
    }
    return value;
  });

  if (ctx.invalidDynamicUsageError) {
    throw ctx.invalidDynamicUsageError;
  }

  // Resolve effective cache life from collected configs.
  //
  // Sequencing invariant: this must run after `fn(...args)` returns. By that
  // point, any nested inner cache's `runCachedFunctionWithContext` has
  // already completed (its `await` in `fn` resolved), and during its own
  // post-execution it pushed its `effectiveLife` into THIS context's
  // `lifeConfigs` (via the `parentCtx.lifeConfigs.push` block below — `ctx`
  // here is `parentCtx` from the inner's perspective). Don't refactor the
  // `await` away or move this resolveCacheLife before the inner's post-
  // execution propagation, or the outer's `lifeConfigs` will be missing the
  // inner's contribution and minimum-wins will silently produce a stale
  // result. Tests in tests/shims.test.ts under "use cache runtime" cover
  // this; the first-child-wins and minimum-wins documenting tests will fail
  // if this invariant is broken.
  //
  // This invariant holds for both sequential inner calls (`await innerA();
  // await innerB()`) and parallel ones (`await Promise.all([innerA(),
  // innerB()])`), because `await cacheContextStorage.run(ctx, () =>
  // fn(...args))` only resolves after `fn`'s returned promise settles —
  // and that promise itself awaits all nested inner calls.
  const effectiveLife = resolveCacheLife(ctx.lifeConfigs);

  // Propagate the inner's resolved cache life into the parent's lifeConfigs so
  // the outer's minimum-wins computation includes the inner's values. This
  // matches Next.js, which propagates the inner's resolved metadata into the
  // outer's revalidate store via `propagateCacheLifeAndTagsToRevalidateStore`
  // (see use-cache-wrapper.ts: minimum-wins on revalidate/expire/stale). It is
  // also load-bearing for the nested-dynamic error detection below: without
  // this propagation, the outer's `effectiveLife` would not reflect the
  // inner's dynamic values, the `revalidate === 0` / `expire < DYNAMIC_EXPIRE`
  // threshold checks below would evaluate false, and the throw would never
  // fire. (The `hasExplicit*` guards then independently decide whether to
  // suppress the throw — see the longer comment below.)
  if (parentCtx) {
    parentCtx.lifeConfigs.push(effectiveLife);
    // Bubble this inner cache's tags into the parent cache scope so the
    // outer entry (and ultimately the request) is invalidated when a tag
    // declared by a nested `"use cache"` is revalidated. Matches Next.js's
    // `propagateCacheLifeAndTagsToRevalidateStore`. Deduped to keep the
    // parent's tag list tidy across many nested calls (issue #1453).
    for (const tag of ctx.tags) {
      if (!parentCtx.tags.includes(tag)) {
        parentCtx.tags.push(tag);
      }
    }
    if (parentCtx.variant !== "private") {
      for (const name of ctx.readRootParamNames ?? []) {
        parentCtx.readRootParamNames?.add(name);
      }
    }
  }

  // Propagate the eager error to the parent if this inner cache resolved
  // dynamic. `??=` keeps the first dynamic child as the cause, matching
  // Next.js: see `dynamicNestedCacheError ??=` in
  // packages/next/src/server/use-cache/use-cache-wrapper.ts.
  if (
    parentCtx &&
    eagerError &&
    (effectiveLife.revalidate === 0 ||
      (effectiveLife.expire !== undefined && effectiveLife.expire < DYNAMIC_EXPIRE))
  ) {
    parentCtx.dynamicNestedCacheError ??= eagerError;
  }

  // If a nested inner cache propagated a dynamic life into this context,
  // and this outer cache lacks an explicit cacheLife for the relevant field,
  // throw the nested-dynamic error now.
  //
  // This block is tightly coupled with the `lifeConfigs.push(effectiveLife)`
  // above: it relies on the inner's dynamic values being merged into this
  // outer's `effectiveLife` via minimum-wins. When the outer has its own
  // explicit `cacheLife()`, the effective life may still be dynamic
  // (e.g., `Math.min(60, 0) === 0`), so the threshold checks (`revalidate
  // === 0` / `expire < DYNAMIC_EXPIRE`) below remain `true`. What actually
  // suppresses the throw is the `!ctx.hasExplicitRevalidate` /
  // `!ctx.hasExplicitExpire` guard: those flags are set whenever the
  // outer calls `cacheLife()` at all (see cache.ts), so the outer's
  // explicit choice opts it out of the error even though the merged
  // effective life remains dynamic. The captured `cause` is then silently
  // discarded, which is the desired behavior — the outer made an explicit
  // choice that overrides the dynamic child. Do not remove the
  // `hasExplicit*` guards under the assumption that minimum-wins alone
  // gates the throw; it does not.
  //
  // If both `revalidate === 0` and `expire < DYNAMIC_EXPIRE` are true,
  // only the revalidate error is thrown (the expire branch is unreachable),
  // matching Next.js which surfaces `revalidate: 0` first.
  //
  // The throw is gated on either the build's prerender phase
  // (`VINEXT_PRERENDER=1`, set by build/prerender.ts when running prerender)
  // or development mode. This matches Next.js, which only throws when the
  // work unit type is `prerender` or `request` in development (see
  // use-cache-wrapper.ts cases 'prerender'/'request' at the read site).
  // Production dynamic SSR is not subject to the throw — a runtime request
  // that nests a dynamic cache inside a non-cacheLife() outer will just run
  // both functions; the outer simply won't be cached (minimum-wins resolves
  // its effective revalidate to 0). The error messages explicitly say "not
  // allowed during prerendering" — outside prerendering/dev, surfacing the
  // throw would be misleading and would diverge from Next.js.
  //
  // Semantic note on `effectiveLife.revalidate === 0`: this checks the
  // *outer's merged* effective life after minimum-wins, not the *inner's
  // entry metadata* directly (as Next.js does via `rdcResult.entry.revalidate`
  // at the read site). The behavior is functionally equivalent in all
  // observable cases because the `hasExplicitRevalidate`/`hasExplicitExpire`
  // guards cover the scenarios where the merge could mask the inner's
  // contribution:
  //   - Outer no cacheLife, inner revalidate:0 → merged effective is 0,
  //     hasExplicit is false, throw fires. (Same outcome as checking inner.)
  //   - Outer cacheLife({ revalidate: 60 }), inner revalidate:0 → merged
  //     effective is 0 (min), hasExplicit is true, throw is suppressed.
  //     (Same outcome — Next.js also suppresses via hasExplicit.)
  //   - Outer cacheLife({ revalidate: 0 }), inner revalidate:0 → merged
  //     effective is 0, hasExplicit is true, throw is suppressed.
  //     (Same outcome.)
  // We use `effectiveLife` here rather than tracking the inner entry's
  // revalidate separately because vinext doesn't model a CacheResultMetadata
  // type — the inner's contribution lives in `parentCtx.lifeConfigs` and
  // gets resolved as part of the outer's minimum-wins on the next iteration.
  const shouldThrow =
    typeof process !== "undefined" &&
    (process.env.VINEXT_PRERENDER === "1" || process.env.NODE_ENV === "development");
  if (shouldThrow && ctx.dynamicNestedCacheError) {
    if (effectiveLife.revalidate === 0 && !ctx.hasExplicitRevalidate) {
      throw new Error(getNestedCacheZeroRevalidateErrorMessage(), {
        cause: ctx.dynamicNestedCacheError,
      });
    }
    if (
      effectiveLife.expire !== undefined &&
      effectiveLife.expire < DYNAMIC_EXPIRE &&
      !ctx.hasExplicitExpire
    ) {
      throw new Error(getNestedCacheShortExpireErrorMessage(), {
        cause: ctx.dynamicNestedCacheError,
      });
    }
  }

  return { result, ctx, effectiveLife, collectedResult };
}

// ---------------------------------------------------------------------------
// Unwrap Promise-augmented objects for cache key generation
// ---------------------------------------------------------------------------

/**
 * Recursively unwrap "thenable objects" — values created by
 * `Object.assign(Promise.resolve(obj), obj)` — into plain objects.
 *
 * Next.js 16 params and searchParams are passed as Promise-augmented objects
 * that work both as `await params` and `params.key`. When these are fed to
 * `encodeReply` with `temporaryReferences`, the Promise is treated as a
 * temporary reference and its actual values are **excluded** from the
 * serialized output. This means different param values (e.g.,
 * `section:"sports"` vs `section:"electronics"`) produce identical cache keys.
 *
 * This function extracts the own enumerable properties into plain objects
 * so `encodeReply` can serialize the actual values into the cache key.
 * Only used for cache key generation — the original Promise-augmented
 * objects are still passed to the actual function on cache miss.
 */
type UnwrapThenableObjectsOptions = {
  omitAppPageSearchParamsAtRoot?: boolean;
};

type UnwrapThenableObjectArrayOptions = {
  omitAppPageSearchParamsFromFirstArg: boolean;
};

function unwrapThenableObjects(
  value: unknown,
  options: UnwrapThenableObjectsOptions = {},
): unknown {
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => unwrapThenableObjects(item));
  }

  // Detect thenable (Promise-like) with own enumerable properties —
  // this is the Object.assign(Promise.resolve(obj), obj) pattern.
  // oxlint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (value as any).then === "function") {
    const keys = Object.keys(value);
    if (keys.length > 0) {
      const plain: Record<string, unknown> = {};
      for (const key of keys) {
        // oxlint-disable-next-line typescript/no-explicit-any
        plain[key] = unwrapThenableObjects((value as any)[key]);
      }
      return plain;
    }
    // Pure Promise with no own properties — leave as-is
    return value;
  }

  // Regular object — recurse into values
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (
      key === "searchParams" &&
      (options.omitAppPageSearchParamsAtRoot || isMarkedAppPagePropsObject(value))
    ) {
      continue;
    }
    // oxlint-disable-next-line @typescript-eslint/no-explicit-any
    result[key] = unwrapThenableObjects((value as any)[key]);
  }
  return result;
}

function unwrapThenableObjectArray(
  values: readonly unknown[],
  options: UnwrapThenableObjectArrayOptions,
): unknown[] {
  return values.map((value, index) =>
    unwrapThenableObjects(value, {
      omitAppPageSearchParamsAtRoot: index === 0 && options.omitAppPageSearchParamsFromFirstArg,
    }),
  );
}

// ---------------------------------------------------------------------------
// Fallback: stable JSON serialization for cache keys (when RSC unavailable)
// ---------------------------------------------------------------------------

function stableStringify(value: unknown, seen?: Set<unknown>): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";

  // Bail on non-serializable primitives so the caller can skip caching
  if (typeof value === "function") throw new Error("Cannot serialize function");
  if (typeof value === "symbol") throw new Error("Cannot serialize symbol");

  if (Array.isArray(value)) {
    // Circular reference detection
    if (!seen) seen = new Set();
    if (seen.has(value)) throw new Error("Circular reference");
    seen.add(value);
    const result = "[" + value.map((v) => stableStringify(v, seen)).join(",") + "]";
    seen.delete(value);
    return result;
  }

  if (typeof value === "object" && value !== null) {
    if (value instanceof Date) {
      return `Date(${value.getTime()})`;
    }
    // Circular reference detection
    if (!seen) seen = new Set();
    if (seen.has(value)) throw new Error("Circular reference");
    seen.add(value);
    const keys = Object.keys(value).sort();
    const result =
      "{" +
      keys
        .map(
          (k) =>
            `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k], seen)}`,
        )
        .join(",") +
      "}";
    seen.delete(value);
    return result;
  }

  return JSON.stringify(value);
}
