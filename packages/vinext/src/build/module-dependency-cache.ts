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

/**
 * Dependency lists of source modules, kept across loads of a dev virtual
 * module. An entry is dropped by the file events that make Vite transform the
 * module again: an edit, creation or deletion of the module's own file, and
 * deletion of a file one of its imports resolved to.
 */
export class ModuleDependencyStore<T> {
  private readonly entries = new Map<string, ModuleDependencyEntry<T>>();
  private version = 0;

  async read(
    moduleId: string,
    collect: (moduleId: string) => Promise<ModuleDependencyEntry<T>>,
  ): Promise<T[]> {
    const cached = this.entries.get(moduleId);
    if (cached) return cached.dependencies;

    const version = this.version;
    const entry = await collect(moduleId);
    // A file event during the read can leave the entry outdated, so it is not kept.
    if (entry.cacheable && version === this.version) this.entries.set(moduleId, entry);
    return entry.dependencies;
  }

  /** `files` holds every spelling of one file, such as its symlinked and real path. */
  invalidate(files: readonly string[], event: "create" | "update" | "delete"): void {
    this.version++;
    for (const [moduleId, entry] of this.entries) {
      if (
        files.includes(stripViteModuleQuery(moduleId)) ||
        (event === "delete" && entry.resolvedFiles.some((file) => files.includes(file)))
      ) {
        this.entries.delete(moduleId);
      }
    }
  }

  clear(): void {
    this.version++;
    this.entries.clear();
  }
}
