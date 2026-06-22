import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";

export class NoCdnCacheAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = false;

  async get(): Promise<null> {
    return null;
  }

  async set(): Promise<void> {}

  buildResponseHeaders(_input: CdnCacheableHeaderInput): CdnResponseHeaders {
    return { "Cache-Control": "no-store", "CDN-Cache-Control": null, "Cache-Tag": null };
  }

  async revalidateTag(): Promise<void> {}
}

const createNoCdnCacheAdapter = (): CdnCacheAdapter => new NoCdnCacheAdapter();

export default createNoCdnCacheAdapter;
