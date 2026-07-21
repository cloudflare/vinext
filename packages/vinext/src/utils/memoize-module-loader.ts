/**
 * Memoize a lazy module loader without permanently caching a failed load.
 *
 * Concurrent callers share the same in-flight promise. Once it resolves, the
 * module remains cached for the lifetime of this importer. A rejection clears
 * the cache so a later request retains the retry behavior of a direct import.
 */
export function memoizeModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;

  return () => {
    if (!promise) {
      const loading = load();
      promise = loading;
      void loading.catch(() => {
        if (promise === loading) promise = undefined;
      });
    }
    return promise;
  };
}
