import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

import type {
  ResponseStorePurgeOptions,
  WorkersResponseStore,
} from "@vinext/workers-response-store";
import type {
  CacheControlMetadata,
  CacheHandler,
  CacheHandlerValue,
  IncrementalCacheValue,
} from "vinext/shims/cache";
import type { VinextCacheFunctionInvocation } from "vinext/server/multi-stage";

import { encodeCloudflareCacheTag } from "./cdn-adapter.runtime.js";

type StoredCacheEntry = {
  cacheControl?: CacheControlMetadata;
  lastModified: number;
  value: IncrementalCacheValue | null;
};

type RegenerationScope = {
  captured?: Response;
  targetKey: string;
};

type ResponseStoreInvocation = {
  replayable: boolean;
  serialized: string;
};

const ARRAY_BUFFER_MARKER = "$vinextArrayBuffer";
const CACHE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const CACHE_MAX_AGE = `public, max-age=${CACHE_MAX_AGE_SECONDS}`;
const DATA_ENTRY_PATH = "__vinext_data";
const SOFT_TAG_MARKER_PATH = "__vinext_data_soft_tag";
const REPLAYABLE_HEADER = "X-Vinext-Response-Store-Replayable";
const MAX_CACHE_TAG_HEADER_BYTES = 16 * 1024;
const DATA_REVALIDATOR_ID = "vinext:data";
const CACHE_FUNCTION_REVALIDATOR_ID = "vinext:cache-function";
const invocationStorage = new AsyncLocalStorage<ResponseStoreInvocation>();
const regenerationStorage = new AsyncLocalStorage<RegenerationScope>();

let responseStore: WorkersResponseStore | undefined;

/** Connect the generated Cloudflare worker entry to the configured data adapter. */
export function setResponseStore(store: WorkersResponseStore): void {
  responseStore = store;
}

/** Associate data-cache writes with the response-stage invocation that produced them. */
export function runWithResponseStoreInvocation<T>(
  serialized: string,
  replayable: boolean,
  callback: () => T,
): T {
  return invocationStorage.run({ replayable, serialized }, callback);
}

/** Re-render an invocation and return the exact rewritten data-cache entry. */
export async function captureResponseStoreDataRegeneration(
  key: string,
  callback: () => Promise<void>,
): Promise<Response> {
  const scope: RegenerationScope = { targetKey: key };
  await regenerationStorage.run(scope, callback);
  if (!scope.captured) {
    throw new Error(`vinext response-store regeneration did not rewrite data key ${key}`);
  }
  return scope.captured;
}

function readCacheControlField(
  context: Record<string, unknown> | undefined,
  field: "expire" | "revalidate" | "stale",
): number | false | undefined {
  const cacheControl = context?.cacheControl;
  const value =
    cacheControl && typeof cacheControl === "object"
      ? Reflect.get(cacheControl, field)
      : context?.[field];
  return typeof value === "number" || (field === "revalidate" && value === false)
    ? value
    : undefined;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(bytes).toString("hex");
}

async function cacheRequest(key: string, path = DATA_ENTRY_PATH): Promise<Request> {
  return new Request(`https://vinext-data-cache.invalid/${path}/${await digest(key)}`);
}

function readStringArrayField(
  context: Record<string, unknown> | undefined,
  field: string,
): string[] {
  const value = context?.[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function serialize(entry: StoredCacheEntry): string {
  return JSON.stringify(entry, (_key, value: unknown) =>
    value instanceof ArrayBuffer
      ? { [ARRAY_BUFFER_MARKER]: Buffer.from(value).toString("base64") }
      : value,
  );
}

function deserialize(value: string): StoredCacheEntry | null {
  let entry: unknown;
  try {
    entry = JSON.parse(value, (_key, item: unknown) => {
      if (
        item &&
        typeof item === "object" &&
        typeof Reflect.get(item, ARRAY_BUFFER_MARKER) === "string"
      ) {
        const bytes = Buffer.from(Reflect.get(item, ARRAY_BUFFER_MARKER), "base64");
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      return item;
    });
  } catch {
    return null;
  }

  if (
    !entry ||
    typeof entry !== "object" ||
    typeof Reflect.get(entry, "lastModified") !== "number"
  ) {
    return null;
  }
  const cachedValue = Reflect.get(entry, "value");
  if (
    cachedValue !== null &&
    (!cachedValue ||
      typeof cachedValue !== "object" ||
      typeof Reflect.get(cachedValue, "kind") !== "string")
  ) {
    return null;
  }
  return entry as StoredCacheEntry;
}

function cachePolicy(revalidate: number | false | undefined, expire: number | undefined): string {
  if (revalidate === false || revalidate === undefined) {
    return `public, max-age=${CACHE_MAX_AGE_SECONDS}`;
  }
  return `public, max-age=${Math.max(0, revalidate)}, stale-while-revalidate=${Math.max(
    0,
    (expire ?? revalidate) - revalidate,
  )}`;
}

export class WorkersResponseStoreCacheHandler implements CacheHandler {
  constructor(private readonly store: WorkersResponseStore = responseStore!) {
    if (!store) {
      throw new Error(
        "[vinext] The Workers Response Store adapter must run through its generated Cloudflare worker entry.",
      );
    }
  }

  async get(key: string, context?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    if (regenerationStorage.getStore()?.targetKey === key) return null;

    const request = await cacheRequest(key);
    const response = await this.store.fetch(request);
    if (response.status === 404 && response.headers.get("X-Workers-Response-Store") === "MISS") {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Workers Response Store returned ${response.status}`);
    }

    const entry = deserialize(await response.text());
    if (!entry) {
      await this.store.purge({ pathPrefixes: [new URL(request.url).pathname] });
      return null;
    }

    const invalidatedAt = await Promise.all(
      readStringArrayField(context, "softTags").map(async (tag) => {
        const markerRequest = await cacheRequest(tag, SOFT_TAG_MARKER_PATH);
        const marker = await this.store.fetch(markerRequest);
        if (marker.status === 404 && marker.headers.get("X-Workers-Response-Store") === "MISS") {
          return 0;
        }
        if (!marker.ok) throw new Error(`Workers Response Store returned ${marker.status}`);
        const timestamp = Number(await marker.text());
        return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
      }),
    );
    if (invalidatedAt.some((timestamp) => timestamp > entry.lastModified)) return null;

    const age = Date.now() - entry.lastModified;
    const requestedRevalidate = readCacheControlField(context, "revalidate");
    const requestedStale =
      typeof requestedRevalidate === "number" &&
      requestedRevalidate > 0 &&
      age > requestedRevalidate * 1000;
    let cacheState: string | undefined;
    if (response.headers.get(REPLAYABLE_HEADER) === "1") {
      if (requestedStale) cacheState = "stale";
    } else if (
      typeof entry.cacheControl?.expire === "number" &&
      age > entry.cacheControl.expire * 1000
    ) {
      cacheState = "expired";
    } else if (
      requestedStale ||
      (typeof entry.cacheControl?.revalidate === "number" &&
        entry.cacheControl.revalidate > 0 &&
        age > entry.cacheControl.revalidate * 1000)
    ) {
      cacheState = "stale";
    }
    return {
      lastModified: entry.lastModified,
      value: entry.value,
      ...(cacheState ? { cacheState } : {}),
      ...(entry.cacheControl ? { cacheControl: entry.cacheControl } : {}),
    };
  }

  async set(
    key: string,
    value: IncrementalCacheValue | null,
    context?: Record<string, unknown>,
  ): Promise<void> {
    let revalidate = readCacheControlField(context, "revalidate");
    if (value && "revalidate" in value) revalidate = value.revalidate;
    if (revalidate === 0) return;

    const rawExpire = readCacheControlField(context, "expire");
    const expire = typeof rawExpire === "number" ? rawExpire : undefined;
    const stale = readCacheControlField(context, "stale");
    const cacheControl =
      typeof revalidate === "number" || revalidate === false
        ? {
            revalidate,
            ...(typeof expire === "number" ? { expire } : {}),
            ...(typeof stale === "number" ? { stale } : {}),
          }
        : undefined;
    const tags = new Set<string>();
    if (value && "tags" in value && Array.isArray(value.tags)) {
      for (const tag of value.tags) tags.add(tag);
    }
    if (Array.isArray(context?.tags)) {
      for (const tag of context.tags) if (typeof tag === "string") tags.add(tag);
    }
    const tagHeader = [...tags].map(encodeCloudflareCacheTag).join(",");
    if (tagHeader.length > MAX_CACHE_TAG_HEADER_BYTES) {
      throw new Error("Workers Response Store cache tags exceed the Workers Cache header limit");
    }

    const invocation = invocationStorage.getStore();
    const cacheFunctionInvocation = context?.cacheFunctionInvocation;
    const revalidator =
      cacheFunctionInvocation &&
      typeof cacheFunctionInvocation === "object" &&
      typeof Reflect.get(cacheFunctionInvocation, "referenceId") === "string" &&
      typeof Reflect.get(cacheFunctionInvocation, "encryptedArgs") === "string"
        ? {
            id: CACHE_FUNCTION_REVALIDATOR_ID,
            args: [key, JSON.stringify(cacheFunctionInvocation as VinextCacheFunctionInvocation)],
          }
        : invocation?.replayable
          ? { id: DATA_REVALIDATOR_ID, args: [key, invocation.serialized] }
          : undefined;
    const response = new Response(
      serialize({
        ...(cacheControl ? { cacheControl } : {}),
        lastModified: Date.now(),
        value,
      }),
      {
        headers: {
          "Cache-Control": revalidator ? cachePolicy(revalidate, expire) : CACHE_MAX_AGE,
          ...(tagHeader ? { "Cache-Tag": tagHeader } : {}),
          "Content-Type": "application/json",
          ...(revalidator ? { [REPLAYABLE_HEADER]: "1" } : {}),
        },
      },
    );

    const regeneration = regenerationStorage.getStore();
    if (regeneration) {
      if (key === regeneration.targetKey) regeneration.captured = response;
      return;
    }

    await this.store.put(await cacheRequest(key), response, {
      ...(revalidator ? { revalidator } : {}),
      purgeExisting: true,
    });
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const dataTags = Array.isArray(tags) ? tags : [tags];
    const encodedTags = dataTags.map(encodeCloudflareCacheTag);
    if (!encodedTags.length) return;
    if (durations?.expire && durations.expire > 0) {
      await this.store.refresh({ tags: encodedTags });
    } else {
      const invalidatedAt = String(Date.now());
      await Promise.all(
        dataTags
          .filter((tag) => tag.startsWith("_N_T_"))
          .map(async (tag) =>
            this.store.put(
              await cacheRequest(tag, SOFT_TAG_MARKER_PATH),
              new Response(invalidatedAt, { headers: { "Cache-Control": CACHE_MAX_AGE } }),
              { purgeExisting: true },
            ),
          ),
      );
      await this.store.purge({
        tags: encodedTags,
      } satisfies ResponseStorePurgeOptions);
    }
  }
}

export default function createResponseStoreDataCacheAdapter(): CacheHandler {
  return new WorkersResponseStoreCacheHandler();
}

export { CACHE_FUNCTION_REVALIDATOR_ID, DATA_REVALIDATOR_ID };
