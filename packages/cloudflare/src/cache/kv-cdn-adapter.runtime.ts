import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";
import type { CacheHandlerValue, IncrementalCacheValue } from "vinext/shims/cache";
import { KVCacheHandler } from "./kv-data-adapter.runtime.js";
import type { KvCdnAdapterOptions } from "./kv-cdn-adapter.js";

const DEFAULT_BINDING = "VINEXT_KV_CACHE";
const PENDING_DYNAMIC_CACHE_CONTROL = "no-store, must-revalidate";

export class KvCdnCacheAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = true;

  constructor(private readonly handler: KVCacheHandler) {}

  get(key: string, ctx?: Record<string, unknown>): Promise<CacheHandlerValue | null> {
    return this.handler.get(key, ctx);
  }

  set(
    key: string,
    data: IncrementalCacheValue | null,
    ctx?: Record<string, unknown>,
  ): Promise<void> {
    return this.handler.set(key, data, ctx);
  }

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    return {
      "Cache-Control": input.pendingDynamicCheck
        ? PENDING_DYNAMIC_CACHE_CONTROL
        : input.cacheControl,
    };
  }

  revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    return this.handler.revalidateTag(tags, durations);
  }
}

const createKvCdnCacheAdapter = ({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: KvCdnAdapterOptions;
}): CdnCacheAdapter => {
  const binding = options?.binding ?? DEFAULT_BINDING;
  const namespace = env?.[binding];
  if (!namespace) {
    throw new Error(
      `[vinext] The KV CDN cache adapter requires a \`${binding}\` KV namespace binding.`,
    );
  }
  return new KvCdnCacheAdapter(
    new KVCacheHandler(namespace as ConstructorParameters<typeof KVCacheHandler>[0], {
      appPrefix: options?.appPrefix,
      ttlSeconds: options?.ttlSeconds,
      tagCacheTtlMs: options?.tagCacheTtlMs,
    }),
  );
};

export default createKvCdnCacheAdapter;
