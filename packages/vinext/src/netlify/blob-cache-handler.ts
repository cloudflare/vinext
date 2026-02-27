/**
 * Netlify Blobs-backed CacheHandler for vinext.
 *
 * Provides persistent ISR caching on Netlify using Blobs as the
 * storage backend. Supports time-based expiry (stale-while-revalidate)
 * and tag-based invalidation.
 *
 * Usage in your Netlify function or server entry:
 *
 *   import { BlobCacheHandler } from "vinext/netlify";
 *   import { setCacheHandler } from "vinext/shims/cache";
 *
 *   setCacheHandler(new BlobCacheHandler());
 *   // ... rest of handler
 *
 * The handler uses a deploy-scoped store so each deploy gets a fresh
 * cache, avoiding stale data leaking across deploys.
 */

import { getStore } from "@netlify/blobs";
import type {
  CacheHandler,
  CacheHandlerValue,
  IncrementalCacheValue,
} from "../shims/cache.js";

/** Shape stored in Blobs for each cache entry. */
interface BlobCacheEntry {
  value: IncrementalCacheValue | null;
  tags: string[];
  lastModified: number;
  /** Absolute timestamp (ms) after which the entry is "stale" (but still served). */
  revalidateAt: number | null;
}

/** Key prefix for tag invalidation timestamps. */
const TAG_PREFIX = "__tag:";

/** Key prefix for cache entries. */
const ENTRY_PREFIX = "cache:";

/** Max tag length to prevent key abuse. */
const MAX_TAG_LENGTH = 256;

/** Store name for vinext cache data. */
const STORE_NAME = "vinext-cache";

/**
 * Validate a cache tag. Returns null if invalid.
 * Note: `:` is rejected because TAG_PREFIX and ENTRY_PREFIX use `:` as a
 * separator — allowing `:` in user tags could cause ambiguous key lookups.
 */
function validateTag(tag: string): string | null {
  if (typeof tag !== "string" || tag.length === 0 || tag.length > MAX_TAG_LENGTH) return null;
  // Block control characters, path separators, and special characters.
  // eslint-disable-next-line no-control-regex -- intentional: reject control chars in tags
  if (/[\x00-\x1f/\\:]/.test(tag)) return null;
  return tag;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_KINDS = new Set([
  "FETCH",
  "APP_PAGE",
  "PAGES",
  "APP_ROUTE",
  "REDIRECT",
  "IMAGE",
]);

/**
 * Validate that a parsed JSON value has the expected BlobCacheEntry shape.
 * Returns the validated entry or null if the shape is invalid.
 */
function validateCacheEntry(raw: unknown): BlobCacheEntry | null {
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj.lastModified !== "number") return null;
  if (!Array.isArray(obj.tags)) return null;
  if (
    obj.revalidateAt !== null &&
    typeof obj.revalidateAt !== "number"
  )
    return null;

  // value must be null or a valid cache value object with a known kind
  if (obj.value !== null) {
    if (!obj.value || typeof obj.value !== "object") return null;
    const value = obj.value as Record<string, unknown>;
    if (typeof value.kind !== "string" || !VALID_KINDS.has(value.kind))
      return null;
  }

  return raw as BlobCacheEntry;
}

// ---------------------------------------------------------------------------
// ArrayBuffer serialization helpers
// ---------------------------------------------------------------------------

/**
 * Deep-clone a cache value, converting ArrayBuffer fields to base64 strings
 * so the entire structure can be JSON.stringify'd for Blob storage.
 */
function serializeForJSON(value: IncrementalCacheValue): IncrementalCacheValue {
  if (value.kind === "APP_PAGE") {
    return {
      ...value,
      rscData: value.rscData
        ? (arrayBufferToBase64(value.rscData) as any)
        : undefined,
    };
  }
  if (value.kind === "APP_ROUTE") {
    return {
      ...value,
      body: arrayBufferToBase64(value.body) as any,
    };
  }
  if (value.kind === "IMAGE") {
    return {
      ...value,
      buffer: arrayBufferToBase64(value.buffer) as any,
    };
  }
  return value;
}

/**
 * Restore base64 strings back to ArrayBuffers after JSON.parse.
 * Returns false if any base64 decode fails (corrupted entry).
 */
function restoreArrayBuffers(value: IncrementalCacheValue): boolean {
  if (value.kind === "APP_PAGE" && typeof value.rscData === "string") {
    const decoded = safeBase64ToArrayBuffer(value.rscData as any);
    if (!decoded) return false;
    (value as any).rscData = decoded;
  }
  if (value.kind === "APP_ROUTE" && typeof value.body === "string") {
    const decoded = safeBase64ToArrayBuffer(value.body as any);
    if (!decoded) return false;
    (value as any).body = decoded;
  }
  if (value.kind === "IMAGE" && typeof value.buffer === "string") {
    const decoded = safeBase64ToArrayBuffer(value.buffer as any);
    if (!decoded) return false;
    (value as any).buffer = decoded;
  }
  return true;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Safely decode base64 to ArrayBuffer. Returns null on invalid input
 * instead of throwing a DOMException.
 */
function safeBase64ToArrayBuffer(base64: string): ArrayBuffer | null {
  try {
    return base64ToArrayBuffer(base64);
  } catch {
    console.error("[vinext] Invalid base64 in cache entry");
    return null;
  }
}

export class BlobCacheHandler implements CacheHandler {
  private storeName: string;

  constructor(options?: { storeName?: string }) {
    this.storeName = options?.storeName ?? STORE_NAME;
  }

  private getStore() {
    return getStore(this.storeName);
  }

  async get(
    key: string,
    _ctx?: Record<string, unknown>,
  ): Promise<CacheHandlerValue | null> {
    const store = this.getStore();
    const blobKey = ENTRY_PREFIX + key;
    const raw = await store.get(blobKey);
    if (!raw) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupted JSON — delete and treat as miss
      await store.delete(blobKey);
      return null;
    }

    // Validate deserialized shape before using
    const entry = validateCacheEntry(parsed);
    if (!entry) {
      console.error("[vinext] Invalid cache entry shape for key:", key);
      await store.delete(blobKey);
      return null;
    }

    // Restore ArrayBuffer fields that were base64-encoded for JSON storage
    if (entry.value) {
      const ok = restoreArrayBuffers(entry.value);
      if (!ok) {
        // base64 decode failed — corrupted entry, treat as miss
        await store.delete(blobKey);
        return null;
      }
    }

    // Check tag-based invalidation (parallel for lower latency)
    if (entry.tags.length > 0) {
      const tagResults = await Promise.all(
        entry.tags.map((tag) => store.get(TAG_PREFIX + tag)),
      );
      for (let i = 0; i < entry.tags.length; i++) {
        const tagTime = tagResults[i];
        if (tagTime) {
          const tagTimestamp = Number(tagTime);
          if (Number.isNaN(tagTimestamp) || tagTimestamp >= entry.lastModified) {
            // Tag was invalidated after this entry, or timestamp is corrupted
            // — treat as miss to force re-render
            await store.delete(blobKey);
            return null;
          }
        }
      }
    }

    // Check time-based expiry — return stale with cacheState.
    // Unlike KV, Blobs has no native TTL. Stale entries are cleaned up
    // lazily on access.
    if (entry.revalidateAt !== null && Date.now() > entry.revalidateAt) {
      return {
        lastModified: entry.lastModified,
        value: entry.value,
        cacheState: "stale",
      };
    }

    return {
      lastModified: entry.lastModified,
      value: entry.value,
    };
  }

  async set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    // Collect, validate, and dedupe tags from data and context
    const tagSet = new Set<string>();
    if (data && "tags" in data && Array.isArray(data.tags)) {
      for (const t of data.tags) {
        const validated = validateTag(t);
        if (validated) tagSet.add(validated);
      }
    }
    if (ctx && "tags" in ctx && Array.isArray(ctx.tags)) {
      for (const t of ctx.tags as string[]) {
        const validated = validateTag(t);
        if (validated) tagSet.add(validated);
      }
    }
    const tags = [...tagSet];

    // Determine revalidation time
    let revalidateAt: number | null = null;
    if (ctx) {
      const revalidate =
        (ctx as any).cacheControl?.revalidate ?? (ctx as any).revalidate;
      if (typeof revalidate === "number" && revalidate > 0) {
        revalidateAt = Date.now() + revalidate * 1000;
      }
    }
    if (
      data &&
      "revalidate" in data &&
      typeof data.revalidate === "number" &&
      data.revalidate > 0
    ) {
      revalidateAt = Date.now() + data.revalidate * 1000;
    }

    // Prepare entry — convert ArrayBuffers to base64 for JSON storage
    const serializable = data ? serializeForJSON(data) : null;

    const entry: BlobCacheEntry = {
      value: serializable,
      tags,
      lastModified: Date.now(),
      revalidateAt,
    };

    const store = this.getStore();
    await store.set(ENTRY_PREFIX + key, JSON.stringify(entry));
  }

  async revalidateTag(
    tags: string | string[],
    _durations?: { expire?: number },
  ): Promise<void> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const now = Date.now();
    const validTags = tagList.filter((t) => validateTag(t) !== null);
    const store = this.getStore();
    // Store invalidation timestamp for each tag
    await Promise.all(
      validTags.map((tag) =>
        store.set(TAG_PREFIX + tag, String(now)),
      ),
    );
  }

  resetRequestCache(): void {
    // No-op — Blobs is stateless per request
  }
}
