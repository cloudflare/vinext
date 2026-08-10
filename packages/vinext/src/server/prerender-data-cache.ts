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
import {
  getRequestContext,
  isInsideUnifiedScope,
  queueAfterCallback,
  type UnifiedRequestContext,
} from "vinext/shims/unified-request-context";

export const PRERENDER_DATA_CACHE_DIR = ".vinext-resume-data-cache";
const PENDING_ENTRY_TIMEOUT_MS = 5 * 60_000;
const LOCK_POLL_INTERVAL_MS = 10;

export type PersistedFetchEntry = {
  context?: Record<string, unknown>;
  key: string;
  lastModified: number;
  value: CachedFetchValue;
};

type PersistedFetchVersion = PersistedFetchEntry & {
  /** Stable identity for this exact value, independent of timestamp collisions. */
  version: string;
  /** In-flight prerender requests that may still commit this provisional value. */
  owners?: string[];
};

type PersistedFetchRecord = PersistedFetchVersion & {
  /** False until a cacheable prerender response has consumed this value. */
  committed?: boolean;
  /** Last committed value retained while a refresh is still provisional. */
  previousCommitted?: PersistedFetchVersion;
  /** Older provisional values that overlapping requests may still commit. */
  provisionalVersions?: PersistedFetchVersion[];
};

type PersistMode = "commit" | "preserve" | "provisional";

type RequestEntryTracker = {
  closing: boolean;
  drain: Promise<void> | null;
  entries: Map<string, { latest: string; versions: Set<string> }>;
  owner: string;
  pendingOperations: number;
  resolveDrain: (() => void) | null;
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

function isPersistedFetchEntry(value: unknown): value is PersistedFetchEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<PersistedFetchEntry>;
  return (
    typeof entry.key === "string" &&
    typeof entry.lastModified === "number" &&
    Number.isFinite(entry.lastModified) &&
    entry.value?.kind === "FETCH"
  );
}

function canonicalVersionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalVersionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, canonicalVersionValue(nested)]),
  );
}

function entryVersion(entry: PersistedFetchEntry): string {
  const headers = Object.fromEntries(
    Object.entries(entry.value.data.headers).sort(([a], [b]) => a.localeCompare(b)),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        key: entry.key,
        lastModified: entry.lastModified,
        data: canonicalVersionValue({ ...entry.value.data, headers }),
        cacheControl: canonicalVersionValue(entry.context?.cacheControl),
        revalidate: entry.value.revalidate,
      }),
    )
    .digest("hex");
}

function persistedVersion(
  entry: PersistedFetchEntry & { owners?: unknown; version?: unknown },
): PersistedFetchVersion {
  const { owners, version, ...value } = entry;
  return {
    ...value,
    ...(Array.isArray(owners)
      ? { owners: owners.filter((owner): owner is string => typeof owner === "string") }
      : {}),
    version: typeof version === "string" ? version : entryVersion(entry),
  };
}

function readEntry(filePath: string): PersistedFetchRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedFetchRecord;
    if (!isPersistedFetchEntry(parsed)) return null;
    const previousCommitted = isPersistedFetchEntry(parsed.previousCommitted)
      ? committedPublicVersion(persistedVersion(parsed.previousCommitted))
      : undefined;
    const provisionalVersions = Array.isArray(parsed.provisionalVersions)
      ? parsed.provisionalVersions
          .filter(isPersistedFetchEntry)
          .map((entry) => publicVersion(persistedVersion(entry)))
      : undefined;
    const current = persistedVersion(parsed);
    return {
      ...(parsed.committed === false ? publicVersion(current) : committedPublicVersion(current)),
      committed: parsed.committed,
      ...(previousCommitted ? { previousCommitted } : {}),
      ...(provisionalVersions?.length ? { provisionalVersions } : {}),
    };
  } catch {
    return null;
  }
}

function publicEntry(entry: PersistedFetchEntry): PersistedFetchEntry {
  return {
    context: entry.context,
    key: entry.key,
    lastModified: entry.lastModified,
    value: entry.value,
  };
}

function publicVersion(entry: PersistedFetchVersion): PersistedFetchVersion {
  return {
    ...publicEntry(entry),
    version: entry.version,
    ...(entry.owners?.length ? { owners: [...entry.owners] } : {}),
  };
}

function committedPublicVersion(entry: PersistedFetchVersion): PersistedFetchVersion {
  return { ...publicEntry(entry), version: entry.version };
}

function committedEntry(record: PersistedFetchRecord | null): PersistedFetchEntry | null {
  if (!record) return null;
  if (record.committed !== false) return publicEntry(record);
  return record.previousCommitted ? publicEntry(record.previousCommitted) : null;
}

function committedVersion(record: PersistedFetchRecord): PersistedFetchVersion | null {
  if (record.committed !== false) return committedPublicVersion(record);
  return record.previousCommitted ?? null;
}

function mergeEntryTags(
  entry: PersistedFetchEntry,
  other: PersistedFetchEntry,
): PersistedFetchEntry {
  const tags = [
    ...new Set([
      ...(entry.value.tags ?? []),
      ...(other.value.tags ?? []),
      ...((entry.context?.tags as string[] | undefined) ?? []),
      ...((other.context?.tags as string[] | undefined) ?? []),
    ]),
  ];
  return {
    ...entry,
    context: { ...entry.context, tags },
    value: { ...entry.value, tags },
  };
}

function mergeVersionTags(
  entry: PersistedFetchVersion,
  other: PersistedFetchEntry,
): PersistedFetchVersion {
  const otherOwners = (other as PersistedFetchVersion).owners ?? [];
  const owners = [...new Set([...(entry.owners ?? []), ...otherOwners])];
  return {
    ...mergeEntryTags(entry, other),
    version: entry.version,
    ...(owners.length ? { owners } : {}),
  };
}

function appendProvisionalVersion(
  versions: readonly PersistedFetchVersion[] | undefined,
  incoming: PersistedFetchVersion,
): PersistedFetchVersion[] {
  const result = [...(versions ?? [])];
  const index = result.findIndex((entry) => entry.version === incoming.version);
  if (index === -1) result.push(incoming);
  else result[index] = mergeVersionTags(result[index], incoming);
  return result.sort((a, b) => a.lastModified - b.lastModified);
}

function addVersionOwner(
  entry: PersistedFetchVersion,
  owner: string | undefined,
): PersistedFetchVersion {
  if (!owner || entry.owners?.includes(owner)) return entry;
  return { ...entry, owners: [...(entry.owners ?? []), owner] };
}

function removeVersionOwner(entry: PersistedFetchVersion, owner: string): PersistedFetchVersion {
  const owners = entry.owners?.filter((candidate) => candidate !== owner);
  const result = { ...entry, owners: owners?.length ? owners : undefined };
  return result;
}

function writeEntry(destination: string, entry: PersistedFetchRecord): void {
  const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(entry), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, destination);
}

async function persistEntry(
  prerenderDir: string,
  incoming: PersistedFetchEntry,
  mode: PersistMode,
  owner?: string,
): Promise<string> {
  const directory = cacheDirectory(prerenderDir);
  fs.mkdirSync(directory, { recursive: true });
  const destination = entryPath(prerenderDir, incoming.key);
  const writeLock = writeLockPath(prerenderDir, incoming.key);
  const incomingVersion =
    mode === "provisional"
      ? addVersionOwner(persistedVersion(incoming), owner)
      : persistedVersion(incoming);
  await waitForLock(writeLock);
  try {
    const existing = readEntry(destination);
    let entry: PersistedFetchRecord;

    if (!existing) {
      entry = {
        ...incomingVersion,
        committed: mode === "provisional" ? false : true,
      };
    } else if (existing.version === incomingVersion.version) {
      entry = { ...existing, ...mergeVersionTags(existing, incomingVersion) };
      if (existing.committed !== false) delete entry.owners;
      if (mode === "commit" && existing.committed === false) {
        entry = { ...entry, committed: true };
        delete entry.previousCommitted;
        delete entry.provisionalVersions;
      }
    } else if (existing.lastModified > incomingVersion.lastModified) {
      // The incoming write belongs to an older exact version. Its tags still
      // apply to the shared cache key, but its request owner must remain on
      // that older version rather than acquiring the newer current value.
      entry = { ...existing, ...mergeVersionTags(existing, publicEntry(incomingVersion)) };
      const fallback = committedVersion(existing);
      if (
        mode === "provisional" &&
        fallback?.version !== incomingVersion.version &&
        (!fallback || incomingVersion.lastModified >= fallback.lastModified)
      ) {
        entry.provisionalVersions = appendProvisionalVersion(
          existing.provisionalVersions,
          incomingVersion,
        );
      }
    } else if (mode === "provisional") {
      const previousCommitted = committedVersion(existing);
      let provisionalVersions = existing.provisionalVersions;
      if (existing.committed === false) {
        provisionalVersions = appendProvisionalVersion(
          provisionalVersions,
          publicVersion(existing),
        );
      }
      entry = {
        ...incomingVersion,
        committed: false,
        ...(previousCommitted ? { previousCommitted } : {}),
        ...(provisionalVersions?.length ? { provisionalVersions } : {}),
      };
    } else {
      entry = { ...incomingVersion, committed: true };
    }

    writeEntry(destination, entry);
    return incomingVersion.version;
  } finally {
    removeFile(writeLock);
  }
}

async function finalizeEntryVersion(
  prerenderDir: string,
  key: string,
  version: string,
  owner: string,
  commit: boolean,
): Promise<void> {
  const destination = entryPath(prerenderDir, key);
  const writeLock = writeLockPath(prerenderDir, key);
  await waitForLock(writeLock);
  try {
    const existing = readEntry(destination);
    if (!existing) return;
    const currentMatches = existing.version === version;
    const candidate = currentMatches
      ? existing
      : existing.provisionalVersions?.find((entry) => entry.version === version);
    if (!candidate) return;

    if (commit) {
      if (currentMatches) {
        if (existing.committed !== false) return;
        writeEntry(destination, {
          ...committedPublicVersion(existing),
          committed: true,
        });
        return;
      }

      if (existing.committed !== false) return;
      const previousCommitted = existing.previousCommitted;
      if (previousCommitted && previousCommitted.lastModified > candidate.lastModified) {
        const provisionalVersions = existing.provisionalVersions
          ?.map((entry) => (entry.version === version ? removeVersionOwner(entry, owner) : entry))
          .filter((entry) => entry.owners?.length);
        writeEntry(destination, {
          ...existing,
          provisionalVersions: provisionalVersions?.length ? provisionalVersions : undefined,
        });
        return;
      }

      const provisionalVersions = existing.provisionalVersions?.filter(
        (entry) => entry.version !== version && entry.lastModified > candidate.lastModified,
      );
      writeEntry(destination, {
        ...existing,
        previousCommitted: committedPublicVersion(candidate),
        provisionalVersions: provisionalVersions?.length ? provisionalVersions : undefined,
      });
      return;
    }

    if (!currentMatches) {
      const provisionalVersions = existing.provisionalVersions
        ?.map((entry) => (entry.version === version ? removeVersionOwner(entry, owner) : entry))
        .filter((entry) => entry.owners?.length);
      writeEntry(destination, {
        ...existing,
        provisionalVersions: provisionalVersions?.length ? provisionalVersions : undefined,
      });
      return;
    }

    if (existing.committed !== false) return;
    const current = removeVersionOwner(existing, owner);
    if (current.owners?.length) {
      writeEntry(destination, { ...existing, owners: current.owners });
      return;
    }

    const remaining = (existing.provisionalVersions ?? []).filter((entry) => entry.owners?.length);
    const replacement = remaining.at(-1);
    if (replacement) {
      writeEntry(destination, {
        ...replacement,
        committed: false,
        ...(existing.previousCommitted ? { previousCommitted: existing.previousCommitted } : {}),
        ...(remaining.length > 1 ? { provisionalVersions: remaining.slice(0, -1) } : {}),
      });
    } else if (existing.previousCommitted) {
      writeEntry(destination, {
        ...committedPublicVersion(existing.previousCommitted),
        committed: true,
      });
    } else {
      removeFile(destination);
    }
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
  private readonly requestEntries = new WeakMap<UnifiedRequestContext, RequestEntryTracker>();

  constructor(private readonly prerenderDir: string) {}

  private requestTracker(): RequestEntryTracker | null {
    if (
      typeof process === "undefined" ||
      process.env.VINEXT_PRERENDER !== "1" ||
      !isInsideUnifiedScope()
    ) {
      return null;
    }

    const requestContext = getRequestContext();
    let tracker = this.requestEntries.get(requestContext);
    if (tracker && !tracker.closing) return tracker;

    tracker = {
      closing: false,
      drain: null,
      entries: new Map(),
      owner: `${process.pid}:${Math.random().toString(36).slice(2)}`,
      pendingOperations: 0,
      resolveDrain: null,
    };
    this.requestEntries.set(requestContext, tracker);
    const capturedTracker = tracker;
    requestContext.prerenderDataCacheState.finalizers.add(async () => {
      capturedTracker.closing = true;
      if (capturedTracker.pendingOperations > 0) {
        capturedTracker.drain ??= new Promise<void>((resolve) => {
          capturedTracker.resolveDrain = resolve;
        });
        await capturedTracker.drain;
      }
      if (this.requestEntries.get(requestContext) === capturedTracker) {
        this.requestEntries.delete(requestContext);
      }
      const commit = requestContext.prerenderDataCacheState.commit === true;
      await Promise.all(
        [...capturedTracker.entries].flatMap(([key, tracked]) => {
          const versions = [...tracked.versions];
          return [
            ...(commit
              ? [
                  finalizeEntryVersion(
                    this.prerenderDir,
                    key,
                    tracked.latest,
                    capturedTracker.owner,
                    true,
                  ),
                ]
              : []),
            ...versions
              .filter((version) => !commit || version !== tracked.latest)
              .map((version) =>
                finalizeEntryVersion(this.prerenderDir, key, version, capturedTracker.owner, false),
              ),
          ];
        }),
      );
    });

    const transactionState = requestContext.prerenderDataCacheState;
    if (!transactionState.finalizerQueued) {
      transactionState.finalizerQueued = true;
      queueAfterCallback(requestContext, async () => {
        // Normal after() callbacks start concurrently. Wait until every other
        // callback/promise has settled so cache fills they await are included
        // in the transaction before any handler finalizes its entries.
        while (
          requestContext.afterContext.pendingCallbacks > 1 ||
          requestContext.afterContext.pendingPromises > 0 ||
          requestContext.afterContext.callbacks.length > 0
        ) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        while (transactionState.finalizers.size > 0) {
          const finalizers = [...transactionState.finalizers];
          transactionState.finalizers.clear();
          await Promise.all(finalizers.map((finalize) => finalize()));
        }
        transactionState.finalizerQueued = false;
      });
    }
    return tracker;
  }

  private startRequestOperation(): RequestEntryTracker | null {
    const tracker = this.requestTracker();
    if (tracker) tracker.pendingOperations += 1;
    return tracker;
  }

  private finishRequestOperation(tracker: RequestEntryTracker | null): void {
    if (!tracker) return;
    tracker.pendingOperations -= 1;
    if (tracker.pendingOperations === 0 && tracker.resolveDrain) {
      const resolve = tracker.resolveDrain;
      tracker.resolveDrain = null;
      resolve();
    }
  }

  private async observeEntry(
    tracker: RequestEntryTracker | null,
    key: string,
    entry: CacheHandlerValue,
    context?: Record<string, unknown>,
  ): Promise<void> {
    if (entry.value?.kind !== "FETCH") return;
    const persisted: PersistedFetchEntry = {
      context: persistedContext({
        ...context,
        cacheControl: entry.cacheControl ?? context?.cacheControl,
        tags: entry.value.tags ?? context?.tags,
      }),
      key,
      lastModified: entry.lastModified,
      value: entry.value,
    };
    let version = entryVersion(persisted);
    if (tracker || Array.isArray(context?.tags)) {
      version = await persistEntry(
        this.prerenderDir,
        persisted,
        tracker ? "provisional" : "preserve",
        tracker?.owner,
      );
    }
    this.trackRequestVersion(tracker, key, version);
  }

  private trackRequestVersion(
    tracker: RequestEntryTracker | null,
    key: string,
    version: string,
  ): void {
    if (!tracker) return;
    const tracked = tracker.entries.get(key);
    if (tracked) {
      tracked.latest = version;
      tracked.versions.add(version);
    } else {
      tracker.entries.set(key, { latest: version, versions: new Set([version]) });
    }
  }

  async get(key: string, context?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    const tracker = this.startRequestOperation();
    try {
      const memoryEntry = await this.memory.get(key, context);
      if (memoryEntry) {
        if (
          context?.kind === "FETCH" &&
          (memoryEntry.cacheState === "stale" || memoryEntry.cacheState === "expired")
        ) {
          const claimed = await this.claimStaleEntry(key, context, memoryEntry);
          if (claimed) await this.observeEntry(tracker, key, claimed, context);
          return claimed;
        }
        await this.observeEntry(tracker, key, memoryEntry, context);
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
      if (
        resumed &&
        context?.kind === "FETCH" &&
        (resumed.cacheState === "stale" || resumed.cacheState === "expired")
      ) {
        const claimed = await this.claimStaleEntry(key, context, resumed);
        if (claimed) await this.observeEntry(tracker, key, claimed, context);
        return claimed;
      }
      if (resumed) await this.observeEntry(tracker, key, resumed, context);
      return resumed;
    } finally {
      this.finishRequestOperation(tracker);
    }
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
    const tracker = this.startRequestOperation();
    try {
      await this.memory.set(key, value, context);
      if (value?.kind !== "FETCH") return;
      const stored = await this.memory.get(key);
      if (stored?.value?.kind !== "FETCH") return;
      const version = await persistEntry(
        this.prerenderDir,
        {
          context: persistedContext({
            ...context,
            cacheControl: stored.cacheControl ?? context?.cacheControl,
          }),
          key,
          lastModified: stored.lastModified,
          value: stored.value,
        },
        tracker ? "provisional" : "commit",
        tracker?.owner,
      );
      this.trackRequestVersion(tracker, key, version);
    } finally {
      try {
        await this.releasePendingSet(key);
      } finally {
        this.finishRequestOperation(tracker);
      }
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
    const entry = committedEntry(readEntry(path.join(directory, file)));
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
