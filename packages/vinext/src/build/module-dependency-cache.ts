import { stripViteModuleQuery } from "../utils/path.js";

export function createModuleDependencyCache<T>(
  collect: (moduleId: string) => Promise<T>,
): (moduleId: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();

  return function getModuleDependencies(moduleId: string): Promise<T> {
    const cached = cache.get(moduleId);
    if (cached) return cached;

    const pending = collect(moduleId);
    cache.set(moduleId, pending);
    return pending;
  };
}

export type ModuleDependencyEntry<T> = {
  dependencies: T[];
  /** Files the module's imports resolved to, without Vite queries. */
  resolvedFiles: string[];
  /**
   * False when an import did not resolve. Vite only caches modules that
   * transformed, so it retries those imports on every request. So does the store.
   */
  cacheable: boolean;
};

type FileEvent = { files: readonly string[]; event: "create" | "update" | "delete" };

function isOutdatedBy<T>(
  moduleId: string,
  entry: ModuleDependencyEntry<T>,
  { files, event }: FileEvent,
): boolean {
  return (
    files.includes(stripViteModuleQuery(moduleId)) ||
    (event === "delete" && entry.resolvedFiles.some((file) => files.includes(file)))
  );
}

/**
 * Dependency lists of source modules, kept across loads of a dev virtual
 * module. An entry is dropped by the file events that make Vite transform the
 * module again: an edit, creation or deletion of the module's own file, and
 * deletion of a file one of its imports resolved to.
 */
export class ModuleDependencyStore<T> {
  private readonly entries = new Map<string, ModuleDependencyEntry<T>>();
  // File events seen by each read in flight. null once the store is cleared.
  private readonly pendingReads = new Set<{ events: FileEvent[] | null }>();

  async read(
    moduleId: string,
    collect: (moduleId: string) => Promise<ModuleDependencyEntry<T>>,
  ): Promise<T[]> {
    const cached = this.entries.get(moduleId);
    if (cached) return cached.dependencies;

    const pending: { events: FileEvent[] | null } = { events: [] };
    this.pendingReads.add(pending);
    let entry: ModuleDependencyEntry<T>;
    try {
      entry = await collect(moduleId);
    } finally {
      this.pendingReads.delete(pending);
    }
    // A file event during the read can leave the entry outdated, so it is not kept.
    if (
      entry.cacheable &&
      pending.events &&
      !pending.events.some((event) => isOutdatedBy(moduleId, entry, event))
    ) {
      this.entries.set(moduleId, entry);
    }
    return entry.dependencies;
  }

  /**
   * `files` holds every spelling of one file, such as its symlinked and real
   * path. Returns whether an entry was dropped.
   */
  invalidate(files: readonly string[], event: FileEvent["event"]): boolean {
    const fileEvent = { files, event };
    for (const pending of this.pendingReads) pending.events?.push(fileEvent);
    let dropped = false;
    for (const [moduleId, entry] of this.entries) {
      if (!isOutdatedBy(moduleId, entry, fileEvent)) continue;
      this.entries.delete(moduleId);
      dropped = true;
    }
    return dropped;
  }

  clear(): void {
    for (const pending of this.pendingReads) pending.events = null;
    this.entries.clear();
  }
}
