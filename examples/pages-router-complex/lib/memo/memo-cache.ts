type CacheEntry = {
  expiresAt: number;
  value: unknown;
};

const stores = new Map<string, HeapStore>();

export class HeapStore {
  readonly #entries = new Map<string, CacheEntry>();

  get<T>(key: string): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return;
    }
    return entry.value as T;
  }

  set(key: string, value: unknown, maxAgeSeconds: number): void {
    this.#entries.set(key, {
      expiresAt: Date.now() + maxAgeSeconds * 1_000,
      value,
    });
  }

  async evictByPrefix(prefix: string): Promise<boolean> {
    for (const key of this.#entries.keys()) {
      if (key.startsWith(prefix)) this.#entries.delete(key);
    }
    return true;
  }
}

export function lookupStore(registryName: string): HeapStore | undefined {
  return stores.get(registryName);
}

type ResultCacheOptions<Args extends unknown[], Result> = {
  deriveKey: (...args: Args) => string | number | readonly (string | number)[];
  maxAgeSeconds: number;
  opName: string;
  shouldStore: (result: Result) => boolean;
};

export function buildResultCache({
  registryName,
  store,
}: {
  registryName: string;
  store: HeapStore;
}) {
  stores.set(registryName, store);

  return function cacheResult<Args extends unknown[], Result>(
    operation: (...args: Args) => Result | Promise<Result>,
    options: ResultCacheOptions<Args, Awaited<Result>>,
  ): (...args: Args) => Promise<Awaited<Result>> {
    return async (...args: Args): Promise<Awaited<Result>> => {
      const derived = options.deriveKey(...args);
      const keyParts = Array.isArray(derived) ? derived : [derived];
      const key = [registryName, options.opName, ...keyParts].join(":");
      const cached = store.get<Awaited<Result>>(key);
      if (cached !== undefined) return cached;

      const result = await operation(...args);
      if (options.shouldStore(result)) {
        store.set(key, result, options.maxAgeSeconds);
      }
      return result;
    };
  };
}

