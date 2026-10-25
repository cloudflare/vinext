/**
 * Extended fetch() with Next.js caching semantics.
 *
 * Patches `globalThis.fetch` during server rendering to support:
 *
 *   fetch(url, { next: { revalidate: 60, tags: ['posts'] } })
 *   fetch(url, { cache: 'force-cache' })
 *   fetch(url, { cache: 'no-store' })
 *
 * Cached responses are stored via the pluggable CacheHandler, so
 * revalidateTag() and revalidatePath() invalidate fetch-level caches.
 *
 * Usage (in server entry):
 *   import { withFetchCache, cleanupFetchCache } from './fetch-cache';
 *   const cleanup = withFetchCache();
 *   try { ... render ... } finally { cleanup(); }
 *
 * Or use the async helper:
 *   await runWithFetchCache(async () => { ... render ... });
 */

import { Buffer } from "node:buffer";

import { getDataCacheHandler, type CachedFetchValue, type CacheHandler } from "./cache-handler.js";
import { encodeCacheTags } from "../utils/encode-cache-tag.js";
import { sha256Hex } from "../utils/hash.js";
import { traceAppFetch } from "../server/app-fetch-tracing.js";
import type { FrameworkSpan } from "../server/framework-tracer.js";
import {
  fallbackFetchCacheState as _fallbackState,
  fetchCacheAls as _als,
  getFetchCacheState as _getState,
  resetFallbackFetchCacheState as _resetFallbackState,
  type FetchCacheMode,
  type FetchDedupeEntry,
} from "./fetch-cache-state.js";
import { getHeadersContext, isInsideAnyCacheScope, markDynamicUsage } from "./headers.js";
import { _hasPendingRevalidatedTag, _setRequestScopedCacheLife } from "./cache-request-state.js";
import { getRequestExecutionContext } from "./request-context.js";
import { isInsideUnifiedScope, runWithUnifiedStateMutation } from "./unified-request-context.js";

export {
  addCollectedRequestTags,
  getCurrentFetchSoftTags,
  runWithDetachedFetchObservations,
} from "./fetch-cache-state.js";
export type { FetchCacheMode, FetchCacheState } from "./fetch-cache-state.js";

// ---------------------------------------------------------------------------
// Cache key generation
// ---------------------------------------------------------------------------

/**
 * Headers excluded from the cache key. These are W3C trace context headers
 * that can break request caching and deduplication.
 * All other headers ARE included in the cache key, matching Next.js behavior.
 */
const HEADER_BLOCKLIST = ["traceparent", "tracestate"];

// Cache key version — bump when changing the key format to bust stale entries
const CACHE_KEY_PREFIX = "v8";
const MAX_CACHE_KEY_BODY_BYTES = 1024 * 1024; // 1 MiB

// "Cache indefinitely" duration — mirrors upstream's CACHE_ONE_YEAR_SECONDS.
const ONE_YEAR_SECONDS = 31536000;

class BodyTooLargeForCacheKeyError extends Error {
  constructor() {
    super("Fetch body too large for cache key generation");
  }
}

class SkipCacheKeyGenerationError extends Error {
  constructor() {
    super("Fetch body could not be serialized for cache key generation");
  }
}

/**
 * Extended RequestInit that carries vinext-internal fields alongside standard fetch options.
 * - `_ogBody`: the original (unconsumed) body, stashed after stream tee so the real fetch
 *   can still send it after the body was consumed for cache-key generation.
 * - `next`: Next.js-specific fetch options (revalidate, tags, etc.).
 */
type ExtendedRequestInit = RequestInit & {
  _ogBody?: BodyInit;
  next?: unknown;
};

/**
 * Collect all headers from the request, excluding the blocklist.
 * RequestInit headers replace a Request input's headers rather than merging
 * with them, matching the Request constructor's normalization behavior.
 */
function collectHeaders(input: string | URL | Request, init?: RequestInit): Record<string, string> {
  const headers = getEffectiveRequestHeaders(input, init);
  const collected = Object.fromEntries(headers.entries());

  // Remove blocklisted headers
  for (const blocked of HEADER_BLOCKLIST) {
    delete collected[blocked];
  }

  return collected;
}

function getEffectiveRequestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  return init?.headers !== undefined
    ? new Headers(init.headers)
    : input instanceof Request
      ? input.headers
      : new Headers();
}

/**
 * Check whether a fetch request carries any per-user auth headers.
 * Used for the safety bypass (skip caching when auth headers are present
 * without an explicit cache opt-in).
 */
const AUTH_HEADERS = ["authorization", "cookie", "x-api-key"];

function hasAuthHeaders(input: string | URL | Request, init?: RequestInit): boolean {
  const headers = collectHeaders(input, init);
  return AUTH_HEADERS.some((name) => name in headers);
}

/**
 * Workers' `cf.resolveOverride` sends the request to a different origin
 * without changing the URL or headers, so it must be part of the fetch cache
 * and dedupe keys. Other `cf` properties only tune Cloudflare's edge cache or
 * optimize the same resource, so they stay out of the keys. Next.js has no
 * equivalent because it never runs on Workers.
 */
function getResolveOverride(input: string | URL | Request, init: RequestInit | undefined): unknown {
  // A RequestInit `cf` replaces a Request input's, like the Request constructor.
  const initCf = (init as { cf?: { resolveOverride?: unknown } } | undefined)?.cf;
  const cf =
    initCf !== undefined
      ? initCf
      : input instanceof Request
        ? (input as { cf?: { resolveOverride?: unknown } }).cf
        : undefined;
  return cf?.resolveOverride ?? null;
}

const BYTE_HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));

function encodeBodyBytes(bytes: Uint8Array): string {
  let encoded = "bytes:";
  for (const byte of bytes) {
    encoded += BYTE_HEX[byte];
  }
  return encoded;
}

function concatBodyBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function serializeFormData(
  formData: FormData,
  pushBodyChunk: (chunk: string, byteLength?: number) => void,
  getTotalBodyBytes: () => number,
): Promise<void> {
  const encoder = new TextEncoder();
  for (const [key, val] of formData.entries()) {
    if (typeof val === "string") {
      pushBodyChunk(JSON.stringify([key, { kind: "string", value: val }]));
      continue;
    }
    // Reject obviously oversized metadata before JSON escaping can amplify an
    // attacker-controlled field name, filename, or media type.
    const metadataLowerBound =
      encoder.encode(key).byteLength +
      encoder.encode(val.name).byteLength +
      encoder.encode(val.type).byteLength;
    if (getTotalBodyBytes() + val.size + metadataLowerBound > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }

    const metadata = JSON.stringify([
      key,
      {
        kind: "file",
        name: val.name,
        type: val.type,
        value: "bytes:",
      },
    ]);
    const metadataByteLength = encoder.encode(metadata).byteLength;
    if (getTotalBodyBytes() + val.size + metadataByteLength > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }

    const bytes = new Uint8Array(await val.arrayBuffer());
    pushBodyChunk(
      JSON.stringify([
        key,
        {
          kind: "file",
          name: val.name,
          type: val.type,
          value: encodeBodyBytes(bytes),
        },
      ]),
      bytes.byteLength + metadataByteLength,
    );
  }
}

type ParsedFormContentType = "multipart/form-data" | "application/x-www-form-urlencoded";

function getParsedFormContentType(
  contentType: string | undefined,
): ParsedFormContentType | undefined {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === "multipart/form-data" || mediaType === "application/x-www-form-urlencoded") {
    return mediaType;
  }
  return undefined;
}

function stripMultipartBoundary(contentType: string): string {
  const [type, ...params] = contentType.split(";");
  const keptParams = params
    .map((param) => param.trim())
    .filter(Boolean)
    .filter((param) => !/^boundary\s*=/i.test(param));
  const normalizedType = type.trim().toLowerCase();
  return keptParams.length > 0 ? `${normalizedType}; ${keptParams.join("; ")}` : normalizedType;
}

type SerializedBodyResult = {
  bodyChunks: string[];
  canonicalizedContentType?: string;
  defaultContentType?: string;
  bodyMetadata?: string;
};

const NORMALIZED_FETCH_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

function normalizeFetchMethod(method: string): string {
  const upperMethod = method.toUpperCase();
  return NORMALIZED_FETCH_METHODS.has(upperMethod) ? upperMethod : method;
}

// A view's own properties can shadow `buffer`, `byteOffset` and `byteLength`,
// but runtimes send the bytes its internal slots cover. These intrinsic getters
// read those slots.
function getIntrinsic<T>(prototype: object, key: PropertyKey): (target: unknown) => T {
  // The getter is deliberately invoked with Reflect.apply on the target.
  // oxlint-disable-next-line typescript/unbound-method
  const getter = Object.getOwnPropertyDescriptor(prototype, key)?.get;
  if (!getter) throw new Error(`Missing intrinsic getter: ${String(key)}`);
  return (target) => Reflect.apply(getter, target, []) as T;
}
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
// Undefined for anything that isn't a typed array, rather than throwing.
const getTypedArrayTag = getIntrinsic<string | undefined>(typedArrayPrototype, Symbol.toStringTag);
const getTypedArrayBuffer = getIntrinsic<ArrayBufferLike>(typedArrayPrototype, "buffer");
const getTypedArrayByteOffset = getIntrinsic<number>(typedArrayPrototype, "byteOffset");
const getTypedArrayByteLength = getIntrinsic<number>(typedArrayPrototype, "byteLength");
const getDataViewBuffer = getIntrinsic<ArrayBufferLike>(DataView.prototype, "buffer");
const getDataViewByteOffset = getIntrinsic<number>(DataView.prototype, "byteOffset");
const getDataViewByteLength = getIntrinsic<number>(DataView.prototype, "byteLength");
const getArrayBufferByteLength = getIntrinsic<number>(ArrayBuffer.prototype, "byteLength");

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) return false;
  try {
    getArrayBufferByteLength(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes sent for a binary body chunk: the bytes an ArrayBuffer holds, or
 * those a typed array or DataView covers. Undefined for any other chunk.
 */
function getBinaryChunkBytes(value: unknown): Uint8Array | undefined {
  if (ArrayBuffer.isView(value)) {
    if (getTypedArrayTag(value) !== undefined) {
      return new Uint8Array(
        getTypedArrayBuffer(value),
        getTypedArrayByteOffset(value),
        getTypedArrayByteLength(value),
      );
    }
    return new Uint8Array(
      getDataViewBuffer(value),
      getDataViewByteOffset(value),
      getDataViewByteLength(value),
    );
  }
  if (isArrayBuffer(value)) return new Uint8Array(value);
  return undefined;
}

async function readRequestBodyChunksWithinLimit(
  request: Request,
  effectiveHeaders: Headers,
): Promise<{
  chunks: Uint8Array[];
  contentType: string | undefined;
}> {
  const contentLengthHeader = effectiveHeaders.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }
  }

  const requestClone = request.clone();
  const contentType = effectiveHeaders.get("content-type") ?? undefined;
  const reader = requestClone.body?.getReader();
  if (!reader) {
    return { chunks: [], contentType };
  }

  const chunks: Uint8Array[] = [];
  let totalBodyBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // A runtime may pass other chunk types through (Workers does for
      // iterable bodies). Binary chunks are keyed by their bytes, and others
      // are not keyed.
      const bytes = getBinaryChunkBytes(value);
      if (!bytes) throw new SkipCacheKeyGenerationError();

      totalBodyBytes += bytes.byteLength;
      if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) {
        throw new BodyTooLargeForCacheKeyError();
      }

      chunks.push(bytes);
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    throw err;
  }

  return { chunks, contentType };
}

// Requests the patched fetch builds for bodies serializeBody doesn't key. They
// are never FormData, so their bytes are keyed as sent, without form parsing.
const builtBodyRequests = new WeakSet<Request>();

/**
 * Whether serializeBody keys this init body type itself. Only genuine
 * instances count, so an array (which has keys()) or a Response (which has
 * arrayBuffer()) is sent however the runtime sends it.
 */
function isKeyableInitBody(body: BodyInit): boolean {
  return (
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream ||
    body instanceof FormData ||
    body instanceof Blob
  );
}

/**
 * Copy a cacheable fetch's request when fetch is called, as fetch itself does.
 * Its cache key is built, and it is sent, only after awaits. A URL, headers,
 * body or `cf` the caller changes in the meantime must reach neither: the
 * request would be sent with values its key doesn't hold, and its response
 * cached for the values the key does hold. A stream body is read after the
 * call, as fetch reads it, and sent as the bytes its key is built from.
 */
function snapshotFetchRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): { input: string | URL | Request; init: RequestInit } {
  const snapshotInit: RequestInit & { cf?: unknown } = { ...init };
  // A Request's URL and method can't change, but its headers and `cf` can, so
  // they're copied onto init. Its body is sent as the bytes it's keyed by.
  // RequestInit headers and `cf` replace a Request input's, like the Request
  // constructor.
  const headers =
    snapshotInit.headers !== undefined
      ? snapshotInit.headers
      : input instanceof Request
        ? input.headers
        : undefined;
  if (headers !== undefined) {
    snapshotInit.headers = new Headers(headers);
  }
  const cf =
    snapshotInit.cf !== undefined
      ? snapshotInit.cf
      : input instanceof Request
        ? (input as { cf?: unknown }).cf
        : undefined;
  if (cf !== null && typeof cf === "object") {
    snapshotInit.cf = snapshotCf(cf);
  }
  if (snapshotInit.body !== undefined && snapshotInit.body !== null) {
    snapshotInit.body = snapshotBody(snapshotInit.body);
  }
  return {
    // fetch reads a URL input as a string when it is called.
    input: input instanceof Request ? input : String(input),
    init: snapshotInit,
  };
}

// `cf` options are plain data, some of them nested (`image`, `cacheTags`).
// Workers copies them as JSON when fetch is called, which drops values JSON
// can't hold, like functions.
function snapshotCf(cf: object): object {
  try {
    return JSON.parse(JSON.stringify(cf)) as object;
  } catch {
    // Options JSON can't hold, like a cycle, are left for the runtime to reject.
    return cf;
  }
}

function snapshotBody(body: BodyInit): BodyInit {
  const bytes = getBinaryChunkBytes(body);
  if (bytes) return bytes.slice();
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  if (body instanceof FormData) {
    const formData = new FormData();
    for (const [name, value] of body) {
      formData.append(name, typeof value === "string" ? value : snapshotBlob(value));
    }
    return formData;
  }
  if (body instanceof Blob) return snapshotBlob(body);
  // Strings can't change. A stream can't be read synchronously, so, as in
  // fetch, its chunks are read after the call. They're sent as the bytes
  // they're keyed by, as is any other body, which is built into a Request.
  return body;
}

// A Blob's bytes can't change, but the properties and methods it's keyed and
// sent through can be redefined on it. A new Blob copies its bytes.
function snapshotBlob(blob: Blob): Blob {
  if (blob instanceof File) {
    return new File([blob], blob.name, { type: blob.type, lastModified: blob.lastModified });
  }
  return new Blob([blob], { type: blob.type });
}

/**
 * Serialize request body into string chunks for cache key inclusion.
 * Handles all body types: string, Uint8Array, ReadableStream, FormData, Blob,
 * and Request object bodies.
 * Returns the serialized body chunks and optionally stashes the original body
 * on init as `_ogBody` so it can still be used after stream consumption.
 */
async function serializeBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<SerializedBodyResult> {
  const hasInitBody = init?.body !== undefined && init.body !== null;
  if (!hasInitBody && !(input instanceof Request && input.body)) {
    return { bodyChunks: [] };
  }

  const bodyChunks: string[] = [];
  const encoder = new TextEncoder();
  let totalBodyBytes = 0;
  let canonicalizedContentType: string | undefined;
  let defaultContentType: string | undefined;
  let bodyMetadata: string | undefined = "body-present";
  const hasEffectiveContentType = getEffectiveRequestHeaders(input, init).has("content-type");

  const pushBodyChunk = (chunk: string, byteLength = encoder.encode(chunk).byteLength): void => {
    totalBodyBytes += byteLength;
    if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }
    bodyChunks.push(chunk);
  };
  const pushBodyBytes = (bytes: Uint8Array): void => {
    pushBodyChunk(encodeBodyBytes(bytes), bytes.byteLength);
  };
  const getTotalBodyBytes = (): number => totalBodyBytes;

  const directBodyBytes = getBinaryChunkBytes(init?.body);
  if (init?.body && directBodyBytes) {
    const bytes = directBodyBytes;
    if (bytes.byteLength > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }
    pushBodyBytes(bytes);
    (init as ExtendedRequestInit)._ogBody = init.body;
  } else if (init?.body && typeof (init.body as { getReader?: unknown }).getReader === "function") {
    // ReadableStream
    const readableBody = init.body as ReadableStream<unknown>;
    const [bodyForHashing, bodyForFetch] = readableBody.tee();
    (init as ExtendedRequestInit)._ogBody = bodyForFetch;
    const reader = bodyForHashing.getReader();
    const chunks: Uint8Array[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Workers also sends the bytes of ArrayBuffer and other typed array
        // chunks, so those are keyed by their bytes. Other chunks are not keyed.
        const bytes =
          typeof value === "string" ? encoder.encode(value) : getBinaryChunkBytes(value);
        if (!bytes) throw new SkipCacheKeyGenerationError();
        totalBodyBytes += bytes.byteLength;
        if (totalBodyBytes > MAX_CACHE_KEY_BODY_BYTES) {
          throw new BodyTooLargeForCacheKeyError();
        }
        chunks.push(bytes);
      }
      const bytes = concatBodyBytes(chunks);
      bodyChunks.push(encodeBodyBytes(bytes));
      // Send the bytes the key was built from, as Next.js does, rather than
      // chunks the caller could still change.
      (init as ExtendedRequestInit)._ogBody = bytes;
      void bodyForFetch.cancel().catch(() => {});
    } catch (err) {
      // Do not await cancellation of one tee branch: it may not settle until
      // the fallback fetch starts consuming the other branch.
      void reader.cancel().catch(() => {});
      if (err instanceof BodyTooLargeForCacheKeyError) {
        throw err;
      }
      throw new SkipCacheKeyGenerationError();
    }
  } else if (init?.body instanceof URLSearchParams) {
    // URLSearchParams — .toString() gives a stable serialization
    (init as ExtendedRequestInit)._ogBody = init.body;
    pushBodyBytes(encoder.encode(init.body.toString()));
    if (!hasEffectiveContentType) {
      defaultContentType = "application/x-www-form-urlencoded;charset=UTF-8";
    }
  } else if (init?.body && typeof (init.body as { keys?: unknown }).keys === "function") {
    // FormData
    const formData = init.body as FormData;
    (init as ExtendedRequestInit)._ogBody = init.body;
    await serializeFormData(formData, pushBodyChunk, getTotalBodyBytes);
    // The generated boundary is transport-specific and the serialized form
    // entries already distinguish bodies, so keep only the stable media type.
    if (!hasEffectiveContentType) {
      defaultContentType = "multipart/form-data";
      bodyMetadata = "body-present;valid-multipart-boundary";
    }
  } else if (
    init?.body &&
    typeof (init.body as { arrayBuffer?: unknown }).arrayBuffer === "function"
  ) {
    // Blob
    const blob = init.body as Blob;
    if (blob.size > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }
    const arrayBuffer = await blob.arrayBuffer();
    pushBodyBytes(new Uint8Array(arrayBuffer));
    (init as ExtendedRequestInit)._ogBody = new Blob([arrayBuffer], { type: blob.type });
    if (!hasEffectiveContentType) {
      defaultContentType = blob.type || undefined;
    }
  } else if (typeof init?.body === "string") {
    // String length is always <= UTF-8 byte length, so this is a
    // cheap lower-bound check that avoids encoder.encode() for huge strings.
    if (init.body.length > MAX_CACHE_KEY_BODY_BYTES) {
      throw new BodyTooLargeForCacheKeyError();
    }
    pushBodyBytes(encoder.encode(init.body));
    (init as ExtendedRequestInit)._ogBody = init.body;
    if (!hasEffectiveContentType) {
      defaultContentType = "text/plain;charset=UTF-8";
    }
  } else if (input instanceof Request && input.body) {
    let chunks: Uint8Array[];
    let contentType: string | undefined;
    try {
      ({ chunks, contentType } = await readRequestBodyChunksWithinLimit(
        input,
        getEffectiveRequestHeaders(input, init),
      ));
    } catch (err) {
      if (err instanceof BodyTooLargeForCacheKeyError) {
        throw err;
      }
      throw new SkipCacheKeyGenerationError();
    }
    // Send the bytes the key is built from rather than the Request's own body,
    // whose chunks the caller could still change.
    if (init) {
      (init as ExtendedRequestInit)._ogBody = concatBodyBytes(chunks);
    }
    const formContentType = builtBodyRequests.has(input)
      ? undefined
      : getParsedFormContentType(contentType);

    if (formContentType) {
      try {
        const boundedRequest = new Request(input.url, {
          method: input.method,
          headers: contentType ? { "content-type": contentType } : undefined,
          body: new Blob(chunks as Uint8Array<ArrayBuffer>[]),
        });
        const formData = await boundedRequest.formData();
        await serializeFormData(formData, pushBodyChunk, getTotalBodyBytes);
        canonicalizedContentType =
          formContentType === "multipart/form-data" && contentType
            ? stripMultipartBoundary(contentType)
            : undefined;
        bodyMetadata =
          formContentType === "multipart/form-data"
            ? "body-present;valid-multipart-boundary"
            : "body-present";
        return { bodyChunks, canonicalizedContentType, bodyMetadata };
      } catch (err) {
        if (err instanceof BodyTooLargeForCacheKeyError) {
          throw err;
        }
        throw new SkipCacheKeyGenerationError();
      }
    }

    pushBodyBytes(concatBodyBytes(chunks));
  }

  return { bodyChunks, canonicalizedContentType, defaultContentType, bodyMetadata };
}

/**
 * Generate a deterministic cache key from a fetch request.
 *
 * Matches Next.js behavior: the key is a SHA-256 hash of a JSON array
 * containing URL, method, all headers (minus blocklist), all RequestInit
 * options, and the serialized body.
 */
async function buildFetchCacheKey(
  input: string | URL | Request,
  init?: RequestInit & { next?: NextFetchOptions },
): Promise<string> {
  let url: string;
  const inputRequest = input instanceof Request ? input : undefined;

  if (typeof input === "string") {
    url = new Request(input).url;
  } else if (input instanceof URL) {
    url = new Request(input).url;
  } else {
    url = input.url;
  }

  const method = normalizeFetchMethod(init?.method ?? inputRequest?.method ?? "GET");

  const headers = collectHeaders(input, init);
  const { bodyChunks, canonicalizedContentType, defaultContentType, bodyMetadata } =
    await serializeBody(input, init);
  if (canonicalizedContentType) {
    headers["content-type"] = canonicalizedContentType;
  } else if (defaultContentType && headers["content-type"] === undefined) {
    headers["content-type"] = defaultContentType;
  }

  const cacheString = JSON.stringify([
    CACHE_KEY_PREFIX,
    url,
    method,
    headers,
    init?.mode ?? inputRequest?.mode ?? "cors",
    init?.redirect ?? inputRequest?.redirect ?? "follow",
    init?.credentials ?? inputRequest?.credentials ?? "same-origin",
    init?.referrer ?? inputRequest?.referrer ?? "about:client",
    init?.referrerPolicy ?? inputRequest?.referrerPolicy ?? "",
    init?.integrity ?? inputRequest?.integrity ?? "",
    init?.cache ?? inputRequest?.cache ?? "default",
    bodyChunks,
    bodyMetadata,
    getResolveOverride(input, init),
  ]);

  return sha256Hex(cacheString);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NextFetchOptions = {
  revalidate?: number | false;
  tags?: string[];
};

type InternalNextFetchOptions = NextFetchOptions & { internal?: boolean };

// Extend the standard RequestInit to include `next`
declare global {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface RequestInit {
    next?: NextFetchOptions;
  }
}

// ---------------------------------------------------------------------------
// Background revalidation dedup — one in-flight refetch per cache key.
// Uses Symbol.for() on globalThis so the map is shared across Vite's
// separate RSC and SSR module instances.
// ---------------------------------------------------------------------------

const _PENDING_KEY = Symbol.for("vinext.fetchCache.pendingRefetches");
const _gPending = globalThis as unknown as Record<PropertyKey, unknown>;
const pendingRefetches = (_gPending[_PENDING_KEY] ??= new Map<string, Promise<void>>()) as Map<
  string,
  Promise<void>
>;

// Maximum time a dedup entry can live before being force-cleaned.
// Guards against hung upstream fetches that never settle, which would
// permanently suppress background refetches for that cache key.
const DEDUP_TIMEOUT_MS = 60_000;

/** @internal Reset dedup state — exposed for test isolation only. */
export function _resetPendingRefetches(): void {
  pendingRefetches.clear();
}

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

// Capture the real (unpatched) fetch once, shared across Vite's
// multi-environment module instances via Symbol.for().
const _ORIG_FETCH_KEY = Symbol.for("vinext.fetchCache.originalFetch");
const _gFetch = globalThis as unknown as Record<PropertyKey, unknown>;
const originalFetch: typeof globalThis.fetch = (_gFetch[_ORIG_FETCH_KEY] ??=
  globalThis.fetch) as typeof globalThis.fetch;

const _noop = (): void => {};

let _responseBodyRegistry: FinalizationRegistry<WeakRef<ReadableStream<Uint8Array>>> | undefined;

if (globalThis.FinalizationRegistry) {
  _responseBodyRegistry = new FinalizationRegistry((weakRef) => {
    const stream = weakRef.deref();
    if (stream && !stream.locked) {
      void stream.cancel("Response object has been garbage collected").then(_noop, _noop);
    }
  });
}

function getFetchObservationUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function addDynamicFetchObservation(input: string | URL | Request): void {
  _getState().dynamicFetchUrls.add(getFetchObservationUrl(input));
}

function recordDynamicFetchObservation(input: string | URL | Request): void {
  if (isInsideAnyCacheScope()) return;
  addDynamicFetchObservation(input);
}

function markUncachedFetchForPageOutput(input: string | URL | Request): void {
  if (isInsideAnyCacheScope()) return;
  addDynamicFetchObservation(input);
  // Next.js lowers the active prerender store to zero when an uncached fetch
  // makes the render dynamic. `force-static` is the exception: dynamic usage
  // is suppressed there, so later metadata-only fetches keep inheriting the
  // configured route interval.
  if (getHeadersContext()?.forceStatic !== true) {
    _getState().currentFetchRevalidate = 0;
  }
  markDynamicUsage();
}

function recordCacheableFetchObservation(input: string | URL | Request): void {
  _getState().cacheableFetchUrls.add(getFetchObservationUrl(input));
}

function recordFiniteFetchRevalidate(revalidateSeconds: number): void {
  if (Number.isFinite(revalidateSeconds) && revalidateSeconds > 0) {
    _setRequestScopedCacheLife({ revalidate: revalidateSeconds });
  }
}

function lowerCurrentFetchRevalidate(revalidateSeconds: number): void {
  const state = _getState();
  if (state.currentFetchRevalidate === null || revalidateSeconds < state.currentFetchRevalidate) {
    state.currentFetchRevalidate = revalidateSeconds;
  }
}

function shouldRefreshStaleFetchInForeground(): boolean {
  return _getState().refreshStaleFetchesInForeground;
}

async function buildFetchCacheValue(
  response: Response,
  tags: string[],
  revalidateSeconds: number,
  options?: { cloneForReturn?: boolean },
): Promise<CachedFetchValue | null> {
  if (response.status !== 200) return null;

  const responseForCache = options?.cloneForReturn === false ? response : response.clone();
  const body = Buffer.from(await responseForCache.arrayBuffer()).toString("base64");
  const headers: Record<string, string> = {};
  responseForCache.headers.forEach((v, k) => {
    if (k.toLowerCase() === "set-cookie") return;
    headers[k] = v;
  });

  return {
    kind: "FETCH",
    data: {
      headers,
      body,
      url: response.url,
      status: responseForCache.status,
    },
    tags,
    revalidate: revalidateSeconds,
  };
}

async function writeFetchCacheResponse(
  handler: CacheHandler,
  cacheKey: string,
  response: Response,
  tags: string[],
  revalidateSeconds: number,
  options?: { cloneForReturn?: boolean },
): Promise<void> {
  const cacheValue = await buildFetchCacheValue(response, tags, revalidateSeconds, options);
  if (!cacheValue) return;

  await handler.set(cacheKey, cacheValue, {
    fetchCache: true,
    tags,
    revalidate: revalidateSeconds,
  });
}

async function lowerFetchCacheRevalidateIfNeeded(
  handler: CacheHandler,
  cacheKey: string,
  cachedValue: CachedFetchValue,
  tags: string[],
  revalidateSeconds: number,
): Promise<void> {
  if (
    !Number.isFinite(revalidateSeconds) ||
    revalidateSeconds <= 0 ||
    typeof cachedValue.revalidate !== "number" ||
    cachedValue.revalidate <= revalidateSeconds
  ) {
    return;
  }

  const mergedTags = Array.from(new Set([...(cachedValue.tags ?? []), ...tags]));
  const updatedValue: CachedFetchValue = {
    ...cachedValue,
    tags: mergedTags,
    revalidate: revalidateSeconds,
  };
  await handler.set(cacheKey, updatedValue, {
    fetchCache: true,
    tags: mergedTags,
    revalidate: revalidateSeconds,
  });
}

export function peekCacheableFetchObservations(): string[] {
  return [..._getState().cacheableFetchUrls].sort();
}

export function peekDynamicFetchObservations(): string[] {
  return [..._getState().dynamicFetchUrls].sort();
}

export function consumeDynamicFetchObservations(): string[] {
  const state = _getState();
  const observed = [...state.dynamicFetchUrls].sort();
  state.dynamicFetchUrls = new Set<string>();
  return observed;
}

/**
 * Get tags collected during the current render pass.
 * Useful for associating page-level cache entries with all the
 * fetch tags used during rendering.
 */
export function getCollectedFetchTags(): string[] {
  return [..._getState().currentRequestTags];
}

/**
 * Set path-derived implicit tags for fetch cache reads in the current render.
 *
 * These are intentionally not persisted on fetch entries. They mirror Next.js
 * `softTags`: `revalidatePath()` should make a fetch miss while rendering the
 * affected route, without permanently coupling a shared fetch entry to one path.
 */
export function setCurrentFetchSoftTags(tags: string[]): void {
  _getState().currentFetchSoftTags = [...tags];
}

export function setCurrentFetchCacheMode(mode: FetchCacheMode | null): void {
  _getState().currentFetchCacheMode = mode;
}

export function setCurrentFetchRevalidate(revalidate: number | null): void {
  _getState().currentFetchRevalidate = revalidate;
}

export function setCurrentForceDynamicFetchDefault(enabled: boolean): void {
  _getState().currentForceDynamicFetchDefault = enabled;
}

export function setRefreshStaleFetchesInForeground(enabled: boolean): void {
  _getState().refreshStaleFetchesInForeground = enabled;
}

function isNoStoreFetch(
  cacheDirective: RequestCache | undefined,
  nextOpts: NextFetchOptions | undefined,
): boolean {
  return (
    cacheDirective === "no-store" || cacheDirective === "no-cache" || nextOpts?.revalidate === 0
  );
}

// Note: `revalidate: false` is cacheable-indefinitely (it normalizes to
// INFINITE_CACHE), so it belongs here — and therefore conflicts with
// `only-no-store` — and must not be re-added to `isNoStoreFetch` above.
function isCacheableFetch(
  cacheDirective: RequestCache | undefined,
  nextOpts: NextFetchOptions | undefined,
): boolean {
  return (
    cacheDirective === "force-cache" ||
    nextOpts?.revalidate === false ||
    (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0)
  );
}

// Returns true when the fetch call carries any defined `next.revalidate` value.
// Used by segment cache defaults (default-cache, default-no-store) where
// `revalidate: 0` and `revalidate: false` are both explicit opt-outs that
// should prevent the segment default from kicking in.
function hasExplicitRevalidateValue(nextOpts: NextFetchOptions | undefined): boolean {
  return nextOpts?.revalidate !== undefined;
}

// Matches upstream's `!currentFetchRevalidate` truthiness check in
// noFetchConfigAndForceDynamic.  `false` and `0` are both falsy, so they
// count as "no fetch revalidate config" for the force-dynamic default path.
function isFalsyRevalidate(nextOpts: NextFetchOptions | undefined): boolean {
  return !nextOpts?.revalidate;
}

function resolveSegmentCacheDirective(
  cacheDirective: RequestCache | undefined,
  nextOpts: NextFetchOptions | undefined,
  mode: FetchCacheMode | null,
  forceDynamicFetchDefault: boolean,
): RequestCache | undefined {
  // Explicit segment fetchCache modes (e.g. default-cache/default-no-store)
  // skip this guard and are handled below, taking precedence over the
  // force-dynamic no-store default.
  if (
    forceDynamicFetchDefault &&
    (!mode || mode === "auto") &&
    (cacheDirective === undefined || cacheDirective === "default") &&
    isFalsyRevalidate(nextOpts)
  ) {
    return "no-store";
  }

  if (!mode || mode === "auto") {
    return cacheDirective;
  }

  switch (mode) {
    case "force-cache":
      return "force-cache";
    case "force-no-store":
      return "no-store";
    case "only-cache": {
      if (isNoStoreFetch(cacheDirective, nextOpts)) {
        throw new Error(
          'Route segment config `fetchCache = "only-cache"` conflicts with no-store fetch.',
        );
      }
      return cacheDirective ?? "force-cache";
    }
    case "only-no-store": {
      if (isCacheableFetch(cacheDirective, nextOpts)) {
        throw new Error(
          'Route segment config `fetchCache = "only-no-store"` conflicts with cacheable fetch.',
        );
      }
      return cacheDirective ?? "no-store";
    }
    case "default-cache":
      return cacheDirective ?? (hasExplicitRevalidateValue(nextOpts) ? undefined : "force-cache");
    case "default-no-store":
      return cacheDirective ?? (hasExplicitRevalidateValue(nextOpts) ? undefined : "no-store");
  }

  return cacheDirective;
}

function getFetchCacheDirective(
  input: string | URL | Request,
  init: RequestInit | undefined,
): RequestCache | undefined {
  if (init?.cache !== undefined) {
    return init.cache;
  }
  // Request.cache defaults to "default" even when the caller did not pass a
  // cache mode, so keep segment defaults free to apply in that case.
  if (!(input instanceof Request) || input.cache === "default") {
    return undefined;
  }
  return input.cache;
}

function buildFetchDedupeKey(request: Request, resolveOverride: unknown): string {
  const filteredHeaders = Array.from(request.headers.entries()).filter(
    ([key]) => !HEADER_BLOCKLIST.includes(key.toLowerCase()),
  );

  return JSON.stringify([
    request.method,
    filteredHeaders,
    request.mode,
    request.redirect,
    request.credentials,
    request.referrer,
    request.referrerPolicy,
    request.integrity,
    resolveOverride,
  ]);
}

function createFetchDedupeCandidate(
  input: string | URL | Request,
  init: RequestInit | undefined,
): { url: string; key: string } | null {
  if (init?.signal) {
    return null;
  }

  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }

  if (init?.keepalive) {
    return null;
  }

  // RequestInit overrides a Request input too. Normalize whenever init is
  // present so the dedupe key describes the request that fetch will execute.
  // Eligible GET/HEAD requests have no body stream for this to disturb.
  const request = input instanceof Request && !init ? input : new Request(input, init);

  if ((request.method !== "GET" && request.method !== "HEAD") || request.keepalive) {
    return null;
  }

  return {
    url: request.url,
    key: buildFetchDedupeKey(request, getResolveOverride(input, init)),
  };
}

function buildDedupeClone(body: ReadableStream<Uint8Array> | null, source: Response): Response {
  const cloned = new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: new Headers(source.headers),
  });
  Object.defineProperty(cloned, "url", {
    value: source.url,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  if (_responseBodyRegistry && cloned.body) {
    _responseBodyRegistry.register(cloned, new WeakRef(cloned.body));
  }
  return cloned;
}

function cloneDedupeResponse(response: Response): [Response, Response] {
  // Mirrors Next.js' cloneResponse helper. Native Response.clone() has had
  // undici stream-lifetime bugs in Node, so tee explicitly and register the
  // branches for cleanup if the caller drops a body without consuming it.
  // Always construct fresh Response objects (even for bodyless responses) so
  // the dedupe entry's stored response and the caller's response are distinct
  // — mirrors Next.js, and avoids any "disturbed response" surprise if a
  // runtime tracks consumption state on shared references.
  if (!response.body) {
    return [buildDedupeClone(null, response), buildDedupeClone(null, response)];
  }

  const [body1, body2] = response.body.tee();
  return [buildDedupeClone(body1, response), buildDedupeClone(body2, response)];
}

function buildCachedFetchResponse(
  data: CachedFetchValue["data"],
  input: string | URL | Request,
): Response {
  const response = new Response(Buffer.from(data.body, "base64"), {
    status: data.status ?? 200,
    headers: data.headers,
  });
  // `data.url` is typed as required, but cached entries may cross a
  // serialization boundary (e.g. KV) where a legacy or third-party writer
  // never populated it — fall back to the request URL (what an uncached,
  // redirect-free fetch would report) so consumers that read `response.url`
  // (e.g. to resolve relative redirects) still see a usable absolute URL.
  Object.defineProperty(response, "url", {
    value: data.url ?? getFetchObservationUrl(input),
    configurable: true,
    enumerable: true,
    writable: false,
  });
  // Intentional change from the previous inline reconstruction: cached
  // responses now participate in body-stream cleanup too, so an unconsumed
  // cached body gets cancelled when the Response is GC'd instead of leaking.
  if (_responseBodyRegistry && response.body) {
    _responseBodyRegistry.register(response, new WeakRef(response.body));
  }
  return response;
}

function dedupeFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Response> {
  const state = _getState();
  if (!state.isFetchDedupeActive) {
    return originalFetch(input, init);
  }

  const candidate = createFetchDedupeCandidate(input, init);
  if (!candidate) {
    return originalFetch(input, init);
  }

  const entriesByUrl = state.currentFetchDedupeEntries;
  let entries = entriesByUrl.get(candidate.url);
  if (!entries) {
    entries = [];
    entriesByUrl.set(candidate.url, entries);
  }

  for (const entry of entries) {
    if (entry.key !== candidate.key) continue;

    return entry.promise.then(() => {
      if (!entry.response) {
        throw new Error("[vinext] Missing deduped fetch response");
      }
      const [responseForCaller, responseForFutureCaller] = cloneDedupeResponse(entry.response);
      entry.response = responseForFutureCaller;
      return responseForCaller;
    });
  }

  const promise = originalFetch(input, init);
  const entry: FetchDedupeEntry = {
    key: candidate.key,
    promise,
    response: null,
  };
  entries.push(entry);

  return promise.then(
    (response) => {
      // entry.response holds an unconsumed tee'd branch for the duration of the
      // render scope. The dedupe map is owned by the per-render context and is
      // dropped when runWithFetchDedupe exits, at which point the
      // FinalizationRegistry cancels any still-unconsumed branch.
      const [responseForCaller, responseForFutureCaller] = cloneDedupeResponse(response);
      entry.response = responseForFutureCaller;
      return responseForCaller;
    },
    (err) => {
      // Drop the failed entry so a later fetch to the same URL within this
      // render scope can retry instead of chaining on the rejected promise.
      // Mirrors React.cache() retry-on-error semantics in Next.js, where a
      // new call site naturally creates a fresh cache entry.
      const idx = entries.indexOf(entry);
      if (idx !== -1) entries.splice(idx, 1);
      throw err;
    },
  );
}

/**
 * Create a patched fetch function with Next.js caching semantics.
 *
 * The patched fetch:
 * 1. Checks `cache` and `next` options to determine caching behavior
 * 2. On cache hit, returns the cached response without hitting the network
 * 3. On cache miss, fetches from network, stores in cache, returns response
 * 4. Respects `next.revalidate` for TTL-based revalidation
 * 5. Respects `next.tags` for tag-based invalidation via revalidateTag()
 */
function createPatchedFetch(): typeof globalThis.fetch {
  const patchedFetch = async function patchedFetch(
    input: string | URL | Request,
    init?: RequestInit,
    span?: FrameworkSpan,
  ): Promise<Response> {
    const nextOpts = (init as ExtendedRequestInit | undefined)?.next as
      | NextFetchOptions
      | undefined;
    const state = _getState();
    const hasWorkContext =
      isInsideUnifiedScope() || _als.getStore() !== undefined || _fallbackState.isFetchDedupeActive;
    const fetchIdx = hasWorkContext ? (state.nextFetchId ?? 1) + 1 : undefined;
    if (fetchIdx !== undefined) state.nextFetchId = fetchIdx;
    const recordFetchOutcome = (
      response: Response,
      cacheStatus: "hit" | "miss" | "skip",
      cacheReason: string,
    ): Response => {
      if (fetchIdx !== undefined) {
        span?.setAttributes({
          "next.fetch.idx": fetchIdx,
          "next.fetch.cache_status": cacheStatus,
          "next.fetch.cache_reason": cacheReason,
        });
      }
      return response;
    };
    const fetchCacheMode = state.currentFetchCacheMode;
    const cacheDirective = resolveSegmentCacheDirective(
      getFetchCacheDirective(input, init),
      nextOpts,
      fetchCacheMode,
      state.currentForceDynamicFetchDefault,
    );
    const skipReason =
      fetchCacheMode === "force-no-store" ||
      fetchCacheMode === "only-no-store" ||
      fetchCacheMode === "default-no-store"
        ? `fetchCache = ${fetchCacheMode}`
        : cacheDirective === "no-store" || cacheDirective === "no-cache"
          ? `cache: ${cacheDirective}`
          : nextOpts?.revalidate === 0
            ? "revalidate: 0"
            : "auto no cache";

    // Determine caching behavior:
    // - cache: 'no-store' → skip cache entirely
    // - cache: 'force-cache' → cache indefinitely (revalidate = Infinity)
    // - next.revalidate: false → cache indefinitely (same as force-cache)
    // - next.revalidate: 0 → same as 'no-store'
    // - next.revalidate: N → cache for N seconds
    // - No cache/next options → default behavior (no caching, pass-through)

    // If no caching options at all, just pass through to original fetch
    if (!nextOpts && !cacheDirective) {
      recordDynamicFetchObservation(input);
      return recordFetchOutcome(await dedupeFetch(input, init), "skip", "auto no cache");
    }

    // Explicit no-store or no-cache — bypass cache entirely
    // Deliberate divergence from upstream: Next.js only calls
    // markCurrentScopeAsDynamic for 'no-store'/revalidate: 0, while 'no-cache'
    // merely opts the fetch out of caching. We conservatively mark the page
    // dynamic for 'no-cache' too, since its response is never reusable.
    if (
      cacheDirective === "no-store" ||
      cacheDirective === "no-cache" ||
      nextOpts?.revalidate === 0
    ) {
      // Strip the `next` property before passing to real fetch
      const cleanInit = stripNextFromInit(init, cacheDirective);
      markUncachedFetchForPageOutput(input);
      return recordFetchOutcome(await dedupeFetch(input, cleanInit), "skip", skipReason);
    }

    // Safety: when per-user auth headers are present and the developer hasn't
    // explicitly opted into caching with `cache: 'force-cache'` or an explicit
    // `next.revalidate`, skip the fetch cache so one user's response isn't
    // reused for another through it. This doesn't keep the value out of a
    // stored page (see below). Developers who understand the implications can still force
    // caching by using `cache: 'force-cache'` or `next: { revalidate: N }`.
    // This is an automatic safety bypass, not an explicit opt-out, so it does
    // NOT mark the page dynamic via markDynamicUsage(), and a static page that
    // makes this fetch is still stored. Next.js does the same: an `autoNoCache`
    // fetch doesn't make the page dynamic ("we don't consider autoNoCache to
    // switch to dynamic for ISR", server/lib/patch-fetch.ts). Outside a
    // "use cache" or unstable_cache scope, the fetch is still recorded as a
    // dynamic fetch observation, which keeps the layout that made it out of
    // static layout reuse and, except under force-static, marks the client
    // navigation cache metadata dynamic.
    // Ordering is deliberate: an explicit `no-store`/`no-cache`/`revalidate: 0`
    // takes the stronger branch above and fully marks the page dynamic even
    // when auth headers are present — this bypass only handles auth-keyed
    // fetches that would otherwise be implicitly cacheable.
    const hasExplicitCacheOpt =
      cacheDirective === "force-cache" ||
      nextOpts?.revalidate === false ||
      (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0);
    if (!hasExplicitCacheOpt && hasAuthHeaders(input, init)) {
      const cleanInit = stripNextFromInit(init, cacheDirective);
      recordDynamicFetchObservation(input);
      return recordFetchOutcome(await dedupeFetch(input, cleanInit), "skip", "auto no cache");
    }

    const tags = encodeCacheTags(nextOpts?.tags ?? []);

    // Determine revalidation period
    let revalidateSeconds: number;
    if (cacheDirective === "force-cache") {
      // force-cache means cache indefinitely (we use a very large number)
      revalidateSeconds =
        nextOpts?.revalidate && typeof nextOpts.revalidate === "number"
          ? nextOpts.revalidate
          : ONE_YEAR_SECONDS;
    } else if (nextOpts?.revalidate === false) {
      // revalidate: false means cache indefinitely
      revalidateSeconds = ONE_YEAR_SECONDS;
    } else if (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0) {
      revalidateSeconds = nextOpts.revalidate;
    } else {
      // During prerender, a fetch without an explicit cache lifetime inherits
      // the active route's revalidate value in Next.js. Tags make this fetch
      // cacheable, but do not independently make it cache indefinitely.
      if (tags.length > 0) {
        const routeRevalidate = _getState().currentFetchRevalidate;
        if (routeRevalidate === 0) {
          const cleanInit = stripNextFromInit(init, cacheDirective);
          markUncachedFetchForPageOutput(input);
          return recordFetchOutcome(await dedupeFetch(input, cleanInit), "skip", "revalidate: 0");
        }
        revalidateSeconds =
          routeRevalidate === null || routeRevalidate === Infinity
            ? ONE_YEAR_SECONDS
            : routeRevalidate;
      } else {
        // next: {} with no revalidate or tags — pass through
        const cleanInit = stripNextFromInit(init, cacheDirective);
        recordDynamicFetchObservation(input);
        return recordFetchOutcome(await dedupeFetch(input, cleanInit), "skip", "auto no cache");
      }
    }
    const cacheReason =
      fetchCacheMode === "force-cache" || fetchCacheMode === "default-cache"
        ? `fetchCache = ${fetchCacheMode}`
        : `revalidate: ${nextOpts?.revalidate === false || cacheDirective === "force-cache" ? 0xfffffffe : revalidateSeconds}`;

    // Record cacheable-fetch observation synchronously, before the first await,
    // so that probe-based skip-eligibility checks (e.g. runLayoutProbe) can
    // snapshot the dependency even when callers start a fetch but do not await
    // its result before yielding to the probe harness.
    // If key generation later fails and the fetch falls back to dynamic,
    // recording both cacheable and dynamic is conservative — a false "unsafe"
    // result costs performance, not correctness.
    recordCacheableFetchObservation(input);
    if (typeof nextOpts?.revalidate === "number" && nextOpts.revalidate > 0) {
      // Upstream mutates the active prerender store when an explicit fetch
      // lifetime is shorter. Later metadata-only fetches inherit that live
      // minimum rather than the route's original segment-config seed.
      lowerCurrentFetchRevalidate(nextOpts.revalidate);
      // Only this explicit lifetime shortens the page's. A fetch without a
      // numeric `next.revalidate` (force-cache, `revalidate: false`, tags only
      // or a fetchCache default) stores its entry for a year or the route's
      // revalidate, but leaves a `revalidate = false` page indefinite: Next.js
      // lowers the prerender store only when the fetch's own revalidate is
      // shorter (server/lib/patch-fetch.ts).
      recordFiniteFetchRevalidate(nextOpts.revalidate);
    }
    const reqTags = _getState().currentRequestTags;
    if (tags.length > 0) {
      for (const tag of tags) {
        if (!reqTags.includes(tag)) {
          reqTags.push(tag);
        }
      }
    }

    const softTags = _getState().currentFetchSoftTags;
    let fetchInit: RequestInit | undefined;
    ({ input, init: fetchInit } = snapshotFetchRequest(
      input,
      stripNextFromInit(init, cacheDirective),
    ));
    const initBody = fetchInit.body;
    if (initBody !== undefined && initBody !== null && !isKeyableInitBody(initBody)) {
      // Any other body (an async iterable, or an object the runtime converts
      // to a string) is built into a Request as fetch itself would, and that
      // Request's bytes are keyed and it is sent.
      input = new Request(input, fetchInit);
      builtBodyRequests.add(input);
      fetchInit = {};
    }
    let cacheKey: string;
    try {
      cacheKey = await buildFetchCacheKey(input, fetchInit);
      // Cache-key generation may consume and stash request bodies on fetchInit;
      // normalize again so the real fetch receives the restored body.
      fetchInit = stripNextFromInit(fetchInit, cacheDirective);
    } catch (err) {
      if (
        err instanceof BodyTooLargeForCacheKeyError ||
        err instanceof SkipCacheKeyGenerationError
      ) {
        fetchInit = stripNextFromInit(fetchInit, cacheDirective);
        // The developer opted into caching but we couldn't build a cache key
        // (body too large / unserializable). That is an internal vinext
        // limitation, not an explicit uncached-fetch decision, so additionally
        // record the dynamic fetch observation (outside a cache scope) without
        // marking the page dynamic. A static page that makes this fetch is
        // still stored.
        recordDynamicFetchObservation(input);
        return recordFetchOutcome(await dedupeFetch(input, fetchInit), "miss", cacheReason);
      }
      throw err;
    }
    const handler = getDataCacheHandler();
    let mustBypassPendingRevalidation = _hasPendingRevalidatedTag([...tags, ...softTags]);

    // Try cache first
    try {
      let cached = mustBypassPendingRevalidation
        ? null
        : await handler.get(cacheKey, {
            kind: "FETCH",
            tags,
            softTags,
            revalidate: revalidateSeconds,
          });
      if (
        cached?.value?.kind === "FETCH" &&
        _hasPendingRevalidatedTag([...(cached.value.tags ?? []), ...tags, ...softTags])
      ) {
        mustBypassPendingRevalidation = true;
        cached = null;
      }
      if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState !== "stale") {
        await lowerFetchCacheRevalidateIfNeeded(
          handler,
          cacheKey,
          cached.value,
          tags,
          revalidateSeconds,
        );
        const cachedData = cached.value.data;
        return recordFetchOutcome(buildCachedFetchResponse(cachedData, input), "hit", cacheReason);
      }

      // Stale entry — we could do stale-while-revalidate here, but for fetch()
      // the simpler approach is to just re-fetch (the page-level ISR handles SWR).
      // However, if we have a stale entry, return it and trigger background refetch.
      if (cached?.value && cached.value.kind === "FETCH" && cached.cacheState === "stale") {
        if (shouldRefreshStaleFetchInForeground()) {
          const freshResponse = await dedupeFetch(input, fetchInit);
          await writeFetchCacheResponse(handler, cacheKey, freshResponse, tags, revalidateSeconds);
          return recordFetchOutcome(freshResponse, "miss", cacheReason);
        }

        const staleData = cached.value.data;

        // Background refetch — deduped so only one in-flight refetch runs
        // per cache key, preventing thundering herd on popular endpoints.
        if (!pendingRefetches.has(cacheKey)) {
          const refetchPromise = originalFetch(input, fetchInit)
            .then(async (freshResp) => {
              await writeFetchCacheResponse(handler, cacheKey, freshResp, tags, revalidateSeconds, {
                cloneForReturn: false,
              });
            })
            .catch((err) => {
              const url =
                typeof input === "string"
                  ? input
                  : input instanceof URL
                    ? input.toString()
                    : input.url;
              console.error(
                `[vinext] fetch cache background revalidation failed for ${url} (key=${cacheKey.slice(0, 12)}...):`,
                err,
              );
            })
            .finally(() => {
              // Only clear if we still own the slot — the timeout may have
              // already replaced it with a newer refetch promise.
              if (pendingRefetches.get(cacheKey) === refetchPromise) {
                pendingRefetches.delete(cacheKey);
              }
              clearTimeout(timeoutId);
            });

          pendingRefetches.set(cacheKey, refetchPromise);

          // Safety net: if the upstream fetch hangs forever, force-clean the
          // dedup entry so future stale hits can retry instead of being
          // permanently suppressed.
          const timeoutId = setTimeout(() => {
            if (pendingRefetches.get(cacheKey) === refetchPromise) {
              pendingRefetches.delete(cacheKey);
            }
          }, DEDUP_TIMEOUT_MS);

          getRequestExecutionContext()?.waitUntil(refetchPromise);
        }

        // Return stale data immediately
        return recordFetchOutcome(buildCachedFetchResponse(staleData, input), "hit", cacheReason);
      }
    } catch (cacheErr) {
      // Cache read failed — fall through to network
      console.error("[vinext] fetch cache read error:", cacheErr);
    }

    // Cache miss — fetch from network
    const response = await (mustBypassPendingRevalidation
      ? originalFetch(input, fetchInit)
      : dedupeFetch(input, fetchInit));

    const cacheValue = await buildFetchCacheValue(response, tags, revalidateSeconds);
    if (cacheValue) {
      handler
        .set(cacheKey, cacheValue, {
          fetchCache: true,
          tags,
          revalidate: revalidateSeconds,
        })
        .catch((err) => {
          console.error("[vinext] fetch cache write error:", err);
        });
    }

    return recordFetchOutcome(response, "miss", cacheReason);
  };

  return ((input: string | URL | Request, init?: RequestInit) => {
    if ((init?.next as InternalNextFetchOptions | undefined)?.internal === true) {
      return originalFetch(input, init);
    }
    return traceAppFetch(input, init, (span) => patchedFetch(input, init, span));
  }) as typeof globalThis.fetch;
}

/**
 * Strip the `next` property from RequestInit before passing to real fetch.
 * The `next` property is not a standard fetch option and would cause warnings
 * in some environments.
 */
function stripNextFromInit(
  init?: RequestInit,
  cacheOverride?: RequestCache,
): RequestInit | undefined {
  if (!init) {
    return cacheOverride === undefined ? undefined : { cache: cacheOverride };
  }
  const castInit = init as ExtendedRequestInit;
  const { next: _next, _ogBody, ...rest } = castInit;
  if (cacheOverride !== undefined) {
    rest.cache = cacheOverride;
  }
  // Restore the original body if it was stashed by serializeBody (e.g. after
  // consuming a ReadableStream for cache key generation).
  if (_ogBody !== undefined) {
    rest.body = _ogBody;
  }
  return Object.keys(rest).length > 0 ? rest : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fetch patching — install once, not per-request.
// The patched fetch uses _getState() internally, which reads from ALS
// (concurrent), _fallbackState while withFetchCache() is active, or a
// throwaway state, so per-request isolation is handled at the state level,
// not by swapping globalThis.fetch.
// ---------------------------------------------------------------------------

const _PATCH_KEY = Symbol.for("vinext.fetchCache.patchInstalled");
const _g = globalThis as unknown as Record<PropertyKey, unknown>;

function _ensurePatchInstalled(): void {
  if (_g[_PATCH_KEY]) return;
  _g[_PATCH_KEY] = true;
  globalThis.fetch = createPatchedFetch();
}

/**
 * Install the patched fetch and reset per-request tag state.
 * Returns a cleanup function that clears tags.
 *
 * @deprecated Prefer `runWithFetchCache()` which uses `AsyncLocalStorage.run()`
 * for proper per-request isolation in concurrent environments.
 *
 * Usage:
 *   const cleanup = withFetchCache();
 *   try { await render(); } finally { cleanup(); }
 */
export function withFetchCache(): () => void {
  _ensurePatchInstalled();
  _resetFallbackState(true);

  return () => {
    _resetFallbackState(false);
  };
}

/**
 * Run an async function with patched fetch caching enabled.
 * Uses `AsyncLocalStorage.run()` for proper per-request isolation
 * of collected fetch tags in concurrent server environments.
 */
export async function runWithFetchCache<T>(fn: () => Promise<T>): Promise<T> {
  _ensurePatchInstalled();
  if (isInsideUnifiedScope()) {
    return await runWithUnifiedStateMutation((uCtx) => {
      uCtx.cacheableFetchUrls = new Set<string>();
      uCtx.currentRequestTags = [];
      uCtx.currentFetchSoftTags = [];
      uCtx.dynamicFetchUrls = new Set<string>();
      uCtx.refreshStaleFetchesInForeground = false;
      uCtx.isFetchDedupeActive = true;
      uCtx.currentFetchDedupeEntries = new Map();
      uCtx.nextFetchId = 1;
    }, fn);
  }
  return _als.run(
    {
      cacheableFetchUrls: new Set<string>(),
      currentRequestTags: [],
      currentFetchSoftTags: [],
      currentFetchCacheMode: null,
      currentFetchRevalidate: null,
      currentForceDynamicFetchDefault: false,
      dynamicFetchUrls: new Set<string>(),
      refreshStaleFetchesInForeground: false,
      isFetchDedupeActive: true,
      currentFetchDedupeEntries: new Map(),
      nextFetchId: 1,
    },
    fn,
  );
}

/**
 * Activate per-render fetch memoization without resetting request fetch tags.
 * Next.js request memoization is scoped to React render work, not the whole
 * request pipeline, so route handlers and middleware stay observable.
 *
 * ALS scope lifetime: when `fn` returns synchronously (e.g. wrapping a
 * `renderToReadableStream` call), the ALS scope established here only covers
 * the synchronous portion. Any fetch work that happens later during async
 * stream consumption falls back to the parent ALS store, which is fine when
 * the parent already activated dedupe (the common dispatch case) but means
 * standalone callers must keep the dedupe scope alive across consumption.
 */
export function runWithFetchDedupe<T>(fn: () => T): T;
export function runWithFetchDedupe<T>(fn: () => Promise<T>): Promise<T>;
export function runWithFetchDedupe<T>(fn: () => T | Promise<T>): T | Promise<T> {
  _ensurePatchInstalled();
  const state = _getState();
  if (state.isFetchDedupeActive) {
    return fn();
  }

  if (isInsideUnifiedScope()) {
    return runWithUnifiedStateMutation((uCtx) => {
      uCtx.isFetchDedupeActive = true;
      uCtx.currentFetchDedupeEntries = new Map();
    }, fn);
  }

  return _als.run(
    {
      ...state,
      isFetchDedupeActive: true,
      currentFetchDedupeEntries: new Map(),
    },
    fn,
  );
}

/**
 * Install the patched fetch without creating a standalone ALS scope.
 *
 * `runWithFetchCache()` is the standalone helper: it installs the patch and
 * creates an isolated per-request tag store. The unified request context owns
 * that isolation itself via `currentRequestTags`, so callers inside
 * `runWithRequestContext()` only need the process-global fetch monkey-patch.
 */
export function ensureFetchPatch(): void {
  _ensurePatchInstalled();
}

/**
 * Get the original (unpatched) fetch function.
 * Useful for internal code that should bypass caching.
 */
export function getOriginalFetch(): typeof globalThis.fetch {
  return originalFetch;
}
