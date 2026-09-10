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
import { cacheForRequest } from "vinext/cache";
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
  capture?: ResponseStoreInvocationCapture;
  replayable: boolean;
  serialized: string;
};

export type ResponseStoreInvocationCapture = {
  admittedResponse?: Promise<Response>;
  captureRscData?: boolean;
  rscData?: Promise<ArrayBuffer>;
  streamResponse?: boolean;
};

const ARRAY_BUFFER_MARKER = "$vinextArrayBuffer";
const CACHE_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const CACHE_MAX_AGE = `public, max-age=${CACHE_MAX_AGE_SECONDS}`;
const DATA_ENTRY_PATH = "__vinext_data";
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
  capture?: ResponseStoreInvocationCapture,
): T {
  return invocationStorage.run({ capture, replayable, serialized }, callback);
}

/** Retain the RSC side stream only when the outer response-store invocation requested it. */
export function captureResponseStoreRscData(rscData: Promise<ArrayBuffer>): void {
  const capture = invocationStorage.getStore()?.capture;
  if (capture?.captureRscData) {
    capture.rscData = rscData;
  } else {
    void rscData.catch(() => {});
  }
}

/** Stream the foreground body while retaining an independent admission branch. */
export function deferResponseStoreAdmission(
  response: Response,
  complete: (response: Response) => Promise<Response>,
): Response | null {
  const capture = invocationStorage.getStore()?.capture;
  if (!capture?.streamResponse || !response.body) return null;

  const source = response.body.getReader();
  const admission = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    { highWaterMark: 0 },
    { highWaterMark: 0 },
  );
  const writer = admission.writable.getWriter();
  let admissionOpen = true;
  let foregroundCancelled = false;
  let foregroundCancelReason: unknown;
  let writerReleased = false;

  const releaseSource = () => {
    try {
      source.releaseLock();
    } catch {}
  };
  const releaseWriter = () => {
    if (writerReleased) return;
    writerReleased = true;
    try {
      writer.releaseLock();
    } catch {}
  };
  const cancelSource = (reason: unknown) => {
    try {
      const cancellation = source.cancel(reason);
      releaseSource();
      void cancellation.catch(() => {}).finally(releaseSource);
    } catch {
      releaseSource();
    }
  };
  const finishAdmission = async (failure?: { reason: unknown }) => {
    if (!admissionOpen) return;
    admissionOpen = false;
    if (failure && foregroundCancelled) {
      cancelSource(foregroundCancelReason);
    }
    try {
      if (failure) await writer.abort(failure.reason);
      else await writer.close();
    } catch {
      // Admission may already have rejected or cancelled its branch.
    } finally {
      releaseWriter();
    }
  };
  const writeAdmission = async (chunk: Uint8Array) => {
    if (!admissionOpen) return;
    try {
      await writer.write(chunk);
    } catch {
      admissionOpen = false;
      releaseWriter();
    }
  };
  const foreground = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await source.read();
          if (result.done) {
            releaseSource();
            controller.close();
            await finishAdmission();
            return;
          }
          controller.enqueue(result.value);
          await writeAdmission(result.value);
        } catch (error) {
          releaseSource();
          controller.error(error);
          await finishAdmission({ reason: error });
        }
      },
      cancel(reason) {
        foregroundCancelled = true;
        foregroundCancelReason = reason;
        if (!admissionOpen) {
          cancelSource(reason);
          return;
        }
        void (async () => {
          try {
            while (true) {
              const result = await source.read();
              if (result.done) break;
              await writeAdmission(result.value);
              if (!admissionOpen) {
                cancelSource(reason);
                break;
              }
            }
            releaseSource();
            await finishAdmission();
          } catch (error) {
            releaseSource();
            await finishAdmission({ reason: error });
          }
        })();
      },
    },
    { highWaterMark: 0 },
  );

  capture.admittedResponse = complete(new Response(admission.readable, response));
  void capture.admittedResponse.catch((error) => finishAdmission({ reason: error }));
  void writer.closed.catch((error) => finishAdmission({ reason: error }));
  return new Response(foreground, response);
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
  private readonly tagExpirations = cacheForRequest(() => new Map<string, Promise<number>>());

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

    const softTags = [
      ...new Set(readStringArrayField(context, "softTags").map(encodeCloudflareCacheTag)),
    ].sort();
    if (softTags.length) {
      const key = softTags.join(",");
      const expirations = this.tagExpirations();
      let expiration = expirations.get(key);
      if (!expiration) {
        expiration = this.store.getTagExpiration(softTags, entry.lastModified);
        expirations.set(key, expiration);
      }
      if ((await expiration) >= entry.lastModified) return null;
    }

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
