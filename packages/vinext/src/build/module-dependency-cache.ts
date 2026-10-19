export function createModuleDependencyCache<T>(
  collect: (moduleId: string) => Promise<T>,
  cache = new Map<string, Promise<T>>(),
): (moduleId: string) => Promise<T> {
  return function getModuleDependencies(moduleId: string): Promise<T> {
    const cached = cache.get(moduleId);
    if (cached) return cached;

    const pending = collect(moduleId);
    cache.set(moduleId, pending);
    pending.catch(() => {
      if (cache.get(moduleId) === pending) cache.delete(moduleId);
    });
    return pending;
  };
}
