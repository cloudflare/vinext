import fs from "node:fs";
import path from "pathslash";
import { createHash } from "node:crypto";
import {
  MemoryCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
  type CachedFetchValue,
  type IncrementalCacheValue,
} from "vinext/shims/cache-handler";

export const PRERENDER_DATA_CACHE_DIR = ".vinext-resume-data-cache";
const PENDING_ENTRY_TIMEOUT_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 10;

export type PersistedFetchEntry = {
  context?: Record<string, unknown>;
  key: string;
  lastModified: number;
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
  if (context.fetchCache === true) result.fetchCache = true;
  return result;
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
      const tags = [
        ...new Set([
          ...(existing.value.tags ?? []),
          ...(entry.value.tags ?? []),
          ...((existing.context?.tags as string[] | undefined) ?? []),
          ...((entry.context?.tags as string[] | undefined) ?? []),
        ]),
      ];
      const newest = existing.lastModified > entry.lastModified ? existing : entry;
      entry = {
        ...newest,
        context: { ...newest.context, tags },
        lastModified: Math.max(existing.lastModified, entry.lastModified),
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

  constructor(private readonly prerenderDir: string) {}

  async get(key: string, context?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    const memoryEntry = await this.memory.get(key, context);
    if (memoryEntry) {
      if (memoryEntry.value?.kind === "FETCH" && Array.isArray(context?.tags)) {
        await persistEntry(this.prerenderDir, {
          context: persistedContext({ ...context, tags: memoryEntry.value.tags ?? context.tags }),
          key,
          lastModified: memoryEntry.lastModified,
          value: memoryEntry.value,
        });
      }
      if (
        context?.kind === "FETCH" &&
        (memoryEntry.cacheState === "stale" || memoryEntry.cacheState === "expired")
      ) {
        return this.claimStaleEntry(key, context, memoryEntry);
      }
      return memoryEntry;
    }
    if (context?.kind !== "FETCH") return null;

    let persisted = readEntry(entryPath(this.prerenderDir, key));
    if (!persisted || persisted.key !== key) {
      const pending = pendingPath(this.prerenderDir, key);
      if (tryCreateLock(pending)) return null;

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
        persisted = readEntry(entryPath(this.prerenderDir, key));
        if (persisted?.key === key) break;
        if (lockIsStale(pending)) {
          removeFile(pending);
          if (tryCreateLock(pending)) return null;
        }
      }
    }

    await this.memory.seed(key, persisted.value, persisted.context, {
      lastModified: persisted.lastModified,
    });
    const resumed = await this.memory.get(key, context);
    if (resumed?.value?.kind === "FETCH" && Array.isArray(context?.tags)) {
      await persistEntry(this.prerenderDir, {
        context: persistedContext({ ...context, tags: resumed.value.tags ?? context.tags }),
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
      return this.claimStaleEntry(key, context, resumed);
    }
    return resumed;
  }

  private async claimStaleEntry(
    key: string,
    context: Record<string, unknown>,
    staleEntry: CacheHandlerValue,
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
        await this.memory.seed(key, persisted.value, persisted.context, {
          lastModified: persisted.lastModified,
        });
        return this.memory.get(key, context);
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
    try {
      await this.memory.set(key, value, context);
      if (value?.kind !== "FETCH") return;
      const stored = await this.memory.get(key);
      if (stored?.value?.kind !== "FETCH") return;
      await persistEntry(this.prerenderDir, {
        context: persistedContext(context),
        key,
        lastModified: stored.lastModified,
        value: stored.value,
      });
    } finally {
      await this.releasePendingSet(key);
    }
  }

  async releasePendingSet(key: string): Promise<void> {
    removeFile(pendingPath(this.prerenderDir, key));
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    await this.memory.revalidateTag(tags, durations);
  }

  resetRequestCache(): void {
    this.memory.resetRequestCache?.();
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

/** Seed persisted prerender FETCH entries into the active runtime handler. */
export async function seedPrerenderDataCache(
  prerenderDir: string,
  handler: CacheHandler,
): Promise<number> {
  let seeded = 0;
  for (const entry of readPrerenderDataCacheEntries(prerenderDir)) {
    if (handler.seed) {
      if (
        await handler.seed(entry.key, entry.value, entry.context, {
          lastModified: entry.lastModified,
        })
      ) {
        seeded++;
      }
    } else {
      // Existing custom handlers predate the timestamp-preserving seed hook.
      // Still hand them the build value, and expose the original timestamp in
      // context so adapters can preserve it without adopting the new method.
      await handler.set(entry.key, entry.value, {
        ...entry.context,
        lastModified: entry.lastModified,
      });
      seeded++;
    }
  }
  return seeded;
}
