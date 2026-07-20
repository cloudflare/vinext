import {
  getCacheHandler,
  setCacheHandler,
  type CacheHandler,
  type CacheHandlerValue,
} from "vinext/shims/cache-handler";
import { isrCacheKey } from "vinext/internal/server/isr-cache";

const stateKey = Symbol.for("vinext.fixture.customRevalidateCache");
const fixtureGlobal = globalThis as typeof globalThis & {
  [stateKey]?: { original: CacheHandler; override: FixtureCacheHandler };
};

class FixtureCacheHandler implements CacheHandler {
  readonly entries = new Map<string, CacheHandlerValue>();

  constructor(private readonly delegate: CacheHandler) {}

  async get(key: string, ctx?: Record<string, unknown>) {
    return this.entries.get(key) ?? this.delegate.get(key, ctx);
  }

  async set(key: string, value: CacheHandlerValue["value"], ctx?: Record<string, unknown>) {
    return this.delegate.set(key, value, ctx);
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }) {
    return this.delegate.revalidateTag(tags, durations);
  }

  resetRequestCache() {
    this.delegate.resetRequestCache?.();
  }
}

export function installCustomRevalidateCache(value: CacheHandlerValue["value"]): void {
  const state = (fixtureGlobal[stateKey] ??= (() => {
    const original = getCacheHandler();
    const override = new FixtureCacheHandler(original);
    return { original, override };
  })());
  state.override.entries.clear();
  const entry: CacheHandlerValue = {
    lastModified: Date.now(),
    cacheState: "fresh",
    cacheControl: { revalidate: 3600 },
    value,
  };
  for (const buildId of [undefined, "test-build-id"] as const) {
    state.override.entries.set(isrCacheKey("pages", "/revalidate-parity-target", buildId), entry);
  }
  setCacheHandler(state.override);
}

export function restoreCustomRevalidateCache(): void {
  const state = fixtureGlobal[stateKey];
  if (!state) return;
  setCacheHandler(state.original);
  delete fixtureGlobal[stateKey];
}
