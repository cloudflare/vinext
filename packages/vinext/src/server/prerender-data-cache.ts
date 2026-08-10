import fs from "node:fs";
import path from "pathslash";
import { createHash } from "node:crypto";
import {
  MemoryCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
  type CachedFetchValue,
  type IncrementalCacheValue,
  type ResumeDataCacheEntry,
} from "vinext/shims/cache-handler";
import { getHeadersContext } from "vinext/shims/headers";
import { VINEXT_PRERENDER_SPECULATIVE_HEADER } from "./headers.js";

export const PRERENDER_DATA_CACHE_DIR = ".vinext-resume-data-cache";
const PENDING_ENTRY_TIMEOUT_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 10;

export type PersistedFetchEntry = ResumeDataCacheEntry & {
  value: CachedFetchValue;
};

function cacheDirectory(prerenderDir: string): string {
  return path.join(prerenderDir, PRERENDER_DATA_CACHE_DIR);
}

function entryPath(prerenderDir: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(cacheDirectory(prerenderDir), `${digest}.json`);
}

function pendingPath(prerenderDir: string, key: string): string {
  return entryPath(prerenderDir, key).replace(/\.json$/, ".pending");
}

function writeLockPath(prerenderDir: string, key: string): string {
  return entryPath(prerenderDir, key).replace(/\.json$/, ".write-lock");
}

function removeFile(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function tryCreateLock(filePath: string): boolean {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const descriptor = fs.openSync(filePath, "wx", 0o600);
    fs.closeSync(descriptor);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function lockIsStale(filePath: string): boolean {
  try {
    return Date.now() - fs.statSync(filePath).mtimeMs > PENDING_ENTRY_TIMEOUT_MS;
  } catch {
    return true;
  }
}

async function waitForLock(filePath: string): Promise<void> {
  while (!tryCreateLock(filePath)) {
    if (lockIsStale(filePath)) {
      removeFile(filePath);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
  }
}

function persistedContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {};
  const result: Record<string, unknown> = {};
  if (Array.isArray(context.tags)) {
    result.tags = context.tags.filter((tag): tag is string => typeof tag === "string");
  }
  if (context.cacheControl && typeof context.cacheControl === "object") {
    result.cacheControl = context.cacheControl;
  }
  if (context.cacheKind === "use-cache") result.cacheKind = "use-cache";
  if (context.fetchCache === true) result.fetchCache = true;
  if (context.speculative === true) result.speculative = true;
  return result;
}

function currentPrerenderContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return getHeadersContext()?.headers.get(VINEXT_PRERENDER_SPECULATIVE_HEADER) === "1"
    ? { ...context, speculative: true }
    : context;
}

function isSpeculativeContext(context: Record<string, unknown> | undefined): boolean {
  return context?.speculative === true;
}

function withoutRequestedTags(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!context || !Array.isArray(context.tags)) return context;
  const { tags: _tags, ...rest } = context;
  return rest;
}

function readEntry(filePath: string): PersistedFetchEntry | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<PersistedFetchEntry>;
    if (
      typeof parsed.key !== "string" ||
      typeof parsed.lastModified !== "number" ||
      !Number.isFinite(parsed.lastModified) ||
      parsed.value?.kind !== "FETCH"
    ) {
      return null;
    }
    return parsed as PersistedFetchEntry;
  } catch {
    return null;
  }
}

async function persistEntry(prerenderDir: string, entry: PersistedFetchEntry): Promise<void> {
  const directory = cacheDirectory(prerenderDir);
  fs.mkdirSync(directory, { recursive: true });
  const destination = entryPath(prerenderDir, entry.key);
  const writeLock = writeLockPath(prerenderDir, entry.key);
  await waitForLock(writeLock);
  try {
    const existing = readEntry(destination);
    if (existing) {
      const existingSpeculative = existing.context?.speculative === true;
      const entrySpeculative = entry.context?.speculative === true;
      // A discarded speculative render must never replace a normal value with
      // the same key. Only normal entries are eligible for runtime publication.
      const newest =
        existingSpeculative !== entrySpeculative
          ? existingSpeculative
            ? entry
            : existing
          : existing.lastModified > entry.lastModified
            ? existing
            : entry;
      const tags = [
        ...new Set(
          existingSpeculative === entrySpeculative
            ? [
                ...(existing.value.tags ?? []),
                ...(entry.value.tags ?? []),
                ...((existing.context?.tags as string[] | undefined) ?? []),
                ...((entry.context?.tags as string[] | undefined) ?? []),
              ]
            : [
                ...(newest.value.tags ?? []),
                ...((newest.context?.tags as string[] | undefined) ?? []),
              ],
        ),
      ];
      entry = {
        ...newest,
        context: {
          ...newest.context,
          tags,
          speculative: existingSpeculative && entrySpeculative,
        },
        lastModified: newest.lastModified,
        value: { ...newest.value, tags },
      };
    }
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, destination);
  } finally {
    removeFile(writeLock);
  }
}

/**
 * Build-only data cache shared by prerender workers.
 *
 * The filesystem is the cross-process source of truth while the in-memory
 * handler preserves normal CacheHandler freshness and tag semantics within a
 * worker. Only FETCH entries are persisted: page HTML/RSC artifacts already
 * have their dedicated prerender files and startup seeding path.
 */
export class PrerenderDataCacheHandler implements CacheHandler {
  private readonly memory = new MemoryCacheHandler();
  private readonly speculativeMemory = new MemoryCacheHandler();

  constructor(private readonly prerenderDir: string) {}

  async get(key: string, context?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    context = currentPrerenderContext(context);
    const speculativeRequest = isSpeculativeContext(context);
    let memory = this.memory;
    let readContext = speculativeRequest ? withoutRequestedTags(context) : context;
    let memoryEntry = await memory.get(key, readContext);
    let speculativeEntry = false;
    if (!memoryEntry && speculativeRequest) {
      memory = this.speculativeMemory;
      readContext = context;
      memoryEntry = await memory.get(key, context);
      speculativeEntry = memoryEntry !== null;
    }
    if (memoryEntry) {
      if (
        memoryEntry.value?.kind === "FETCH" &&
        Array.isArray(context?.tags) &&
        (!speculativeRequest || speculativeEntry)
      ) {
        await persistEntry(this.prerenderDir, {
          context: persistedContext({
            ...context,
            speculative: speculativeEntry,
            tags: memoryEntry.value.tags ?? context.tags,
          }),
          key,
          lastModified: memoryEntry.lastModified,
          value: memoryEntry.value,
        });
      }
      if (
        context?.kind === "FETCH" &&
        (memoryEntry.cacheState === "stale" || memoryEntry.cacheState === "expired")
      ) {
        return this.claimStaleEntry(key, readContext ?? context, memoryEntry, memory);
      }
      return memoryEntry;
    }
    if (context?.kind !== "FETCH") return null;

    let persisted = readEntry(entryPath(this.prerenderDir, key));
    if (
      !persisted ||
      persisted.key !== key ||
      (persisted.context?.speculative === true && !speculativeRequest)
    ) {
      const pending = pendingPath(this.prerenderDir, key);
      if (tryCreateLock(pending)) return null;

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
        persisted = readEntry(entryPath(this.prerenderDir, key));
        if (
          persisted?.key === key &&
          (persisted.context?.speculative !== true || speculativeRequest)
        ) {
          break;
        }
        if (lockIsStale(pending)) {
          removeFile(pending);
          if (tryCreateLock(pending)) return null;
        }
      }
    }

    memory = persisted.context?.speculative === true ? this.speculativeMemory : this.memory;
    readContext =
      speculativeRequest && persisted.context?.speculative !== true
        ? withoutRequestedTags(context)
        : context;
    await memory.seed(key, persisted.value, persisted.context, {
      lastModified: persisted.lastModified,
    });
    const resumed = await memory.get(key, readContext);
    if (
      resumed?.value?.kind === "FETCH" &&
      Array.isArray(context?.tags) &&
      (!speculativeRequest || persisted.context?.speculative === true)
    ) {
      await persistEntry(this.prerenderDir, {
        context: persistedContext({
          ...context,
          speculative: persisted.context?.speculative === true,
          tags: resumed.value.tags ?? context.tags,
        }),
        key,
        lastModified: resumed.lastModified,
        value: resumed.value,
      });
    }
    if (
      resumed &&
      context?.kind === "FETCH" &&
      (resumed.cacheState === "stale" || resumed.cacheState === "expired")
    ) {
      return this.claimStaleEntry(key, readContext ?? context, resumed, memory);
    }
    return resumed;
  }

  private async claimStaleEntry(
    key: string,
    context: Record<string, unknown>,
    staleEntry: CacheHandlerValue,
    memory: MemoryCacheHandler,
  ): Promise<CacheHandlerValue | null> {
    const pending = pendingPath(this.prerenderDir, key);
    if (tryCreateLock(pending)) return null;

    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
      const persisted = readEntry(entryPath(this.prerenderDir, key));
      if (
        persisted?.key === key &&
        persisted.lastModified > staleEntry.lastModified &&
        persisted.value.kind === "FETCH"
      ) {
        await memory.seed(key, persisted.value, persisted.context, {
          lastModified: persisted.lastModified,
        });
        return memory.get(key, context);
      }
      if (lockIsStale(pending)) {
        removeFile(pending);
        if (tryCreateLock(pending)) return null;
      }
    }
  }

  async set(
    key: string,
    value: IncrementalCacheValue | null,
    context?: Record<string, unknown>,
  ): Promise<void> {
    context = currentPrerenderContext(context);
    const memory = isSpeculativeContext(context) ? this.speculativeMemory : this.memory;
    try {
      await memory.set(key, value, context);
      if (value?.kind !== "FETCH") return;
      const stored = await memory.get(key);
      if (stored?.value?.kind !== "FETCH") return;
      const entry = {
        context: persistedContext(context),
        key,
        lastModified: stored.lastModified,
        value: stored.value,
      } satisfies PersistedFetchEntry;
      await persistEntry(this.prerenderDir, entry);
    } finally {
      await this.releasePendingSet(key);
    }
  }

  async releasePendingSet(key: string): Promise<void> {
    removeFile(pendingPath(this.prerenderDir, key));
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    await Promise.all([
      this.memory.revalidateTag(tags, durations),
      this.speculativeMemory.revalidateTag(tags, durations),
    ]);
  }

  resetRequestCache(): void {
    this.memory.resetRequestCache?.();
    this.speculativeMemory.resetRequestCache?.();
  }
}

export function createPrerenderDataCacheHandler(prerenderDir: string): CacheHandler {
  return new PrerenderDataCacheHandler(prerenderDir);
}

export function resetPrerenderDataCache(prerenderDir: string): void {
  fs.rmSync(cacheDirectory(prerenderDir), { force: true, recursive: true });
}

export function readPrerenderDataCacheEntries(prerenderDir: string): PersistedFetchEntry[] {
  const directory = cacheDirectory(prerenderDir);
  let files: string[];
  try {
    files = fs.readdirSync(directory);
  } catch {
    return [];
  }

  const entries: PersistedFetchEntry[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const entry = readEntry(path.join(directory, file));
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Process-local read-through view of immutable build snapshots for handlers
 * that cannot atomically seed an entry by timestamp. Runtime data remains
 * authoritative: snapshots are consulted only after a stable delegate miss
 * and are never written into the delegate.
 *
 * This intentionally does not claim distributed invalidation semantics. A
 * shared custom handler needs timestamp-aware `seed()` support for that; the
 * legacy get/set/tag API cannot distinguish an absent value from one invalidated
 * by another process without risking resurrection of stale build data.
 */
class PrerenderDataCacheRuntimeOverlay implements CacheHandler {
  private readonly snapshot = new MemoryCacheHandler();
  private readonly runtimeVersions = new Map<string, number>();
  private readonly pendingWrites = new Map<string, Promise<void>>();

  private constructor(private readonly delegate: CacheHandler) {}

  static async create(
    entries: readonly PersistedFetchEntry[],
    delegate: CacheHandler,
  ): Promise<PrerenderDataCacheRuntimeOverlay> {
    const overlay = new PrerenderDataCacheRuntimeOverlay(delegate);
    for (const entry of entries) {
      await overlay.snapshot.seed(entry.key, entry.value, entry.context, {
        lastModified: entry.lastModified,
      });
    }
    return overlay;
  }

  async get(key: string, context?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    for (;;) {
      const version = this.runtimeVersions.get(key) ?? 0;
      const pending = this.pendingWrites.get(key);
      if (pending) await pending.catch(() => {});

      const runtime = await this.delegate.get(key, context);
      if (runtime) return runtime;

      // A write may have started while the delegate read was in flight. Wait
      // for it and retry the delegate instead of exposing the older snapshot.
      if ((this.runtimeVersions.get(key) ?? 0) !== version || this.pendingWrites.has(key)) {
        continue;
      }
      if (version > 0) return null;

      const snapshot = await this.snapshot.get(key, context);
      if ((this.runtimeVersions.get(key) ?? 0) !== version) continue;
      if (snapshot) {
        // A delegate may claim a miss for single-flight ownership. The caller
        // observes this snapshot as a hit and will never fill that claim, so
        // release it here before returning the process-local fallback.
        await this.delegate.releasePendingSet?.(key);
        if ((this.runtimeVersions.get(key) ?? 0) !== version) continue;
      }
      return snapshot;
    }
  }

  set(
    key: string,
    data: IncrementalCacheValue | null,
    context?: Record<string, unknown>,
  ): Promise<void> {
    this.runtimeVersions.set(key, (this.runtimeVersions.get(key) ?? 0) + 1);
    const write = Promise.resolve().then(() => this.delegate.set(key, data, context));
    const tracked = write.finally(() => {
      if (this.pendingWrites.get(key) === tracked) this.pendingWrites.delete(key);
    });
    this.pendingWrites.set(key, tracked);
    return tracked;
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    await Promise.all([
      this.delegate.revalidateTag(tags, durations),
      this.snapshot.revalidateTag(tags, durations),
    ]);
  }

  async releasePendingSet(key: string): Promise<void> {
    await this.delegate.releasePendingSet?.(key);
  }

  resetRequestCache(): void {
    this.delegate.resetRequestCache?.();
    this.snapshot.resetRequestCache?.();
  }
}

/** Prepare persisted build data for runtime without unsafe custom-handler writes. */
export async function createPrerenderDataCacheRuntimeHandler(
  prerenderDir: string,
  handler: CacheHandler,
): Promise<CacheHandler> {
  if (handler.seed) {
    await seedPrerenderDataCache(prerenderDir, handler);
    return handler;
  }
  const entries = readPrerenderDataCacheEntries(prerenderDir).filter(
    (entry) => entry.context?.speculative !== true,
  );
  return entries.length === 0 ? handler : PrerenderDataCacheRuntimeOverlay.create(entries, handler);
}

/** Seed persisted prerender FETCH entries into the active runtime handler. */
export async function seedPrerenderDataCache(
  prerenderDir: string,
  handler: CacheHandler,
): Promise<number> {
  let seeded = 0;
  for (const entry of readPrerenderDataCacheEntries(prerenderDir)) {
    if (entry.context?.speculative === true) continue;
    if (handler.seed) {
      if (
        await handler.seed(entry.key, entry.value, entry.context, {
          lastModified: entry.lastModified,
        })
      ) {
        seeded++;
      }
    }
  }
  return seeded;
}
