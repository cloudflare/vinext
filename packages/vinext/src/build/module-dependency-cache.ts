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
