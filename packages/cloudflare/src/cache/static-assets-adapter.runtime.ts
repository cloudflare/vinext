import type {
  CacheHandlerValue,
  CachedAppPageValue,
  CachedRouteValue,
  IncrementalCacheValue,
} from "vinext/shims/cache-handler";
import type {
  CdnCacheAdapter,
  CdnCacheableHeaderInput,
  CdnResponseHeaders,
} from "vinext/shims/cdn-cache";
import type { StaticAssetsAdapterOptions } from "./static-assets-adapter.js";
import {
  STATIC_ASSET_CACHE_PATH,
  type StaticAssetCacheIndex,
  type StaticAssetCacheMetadata,
} from "./static-assets-adapter.shared.js";

type AssetFetcher = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

async function cacheAssetId(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isMetadata(value: unknown): value is StaticAssetCacheMetadata {
  return (
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    (value.kind === "html" || value.kind === "rsc" || value.kind === "route") &&
    "lastModified" in value &&
    typeof value.lastModified === "number"
  );
}

export class StaticAssetsCacheAdapter implements CdnCacheAdapter {
  readonly ownsBackgroundRevalidation = false;
  private indexPromise: Promise<StaticAssetCacheIndex | null> | undefined;

  constructor(private readonly assets: AssetFetcher) {}

  private loadIndex(): Promise<StaticAssetCacheIndex | null> {
    return (this.indexPromise ??= this.assets
      .fetch(`https://vinext.invalid${STATIC_ASSET_CACHE_PATH}/index.json`)
      .then(async (response) => (response.ok ? ((await response.json()) as unknown) : null))
      .then((value) =>
        value !== null && typeof value === "object" ? (value as StaticAssetCacheIndex) : null,
      ));
  }

  async get(key: string): Promise<CacheHandlerValue | null> {
    const id = await cacheAssetId(key);
    const metadata: unknown = (await this.loadIndex())?.[id];
    if (!isMetadata(metadata)) return null;

    const extension = metadata.kind === "html" ? "html" : metadata.kind === "rsc" ? "rsc" : "route";
    const bodyResponse = await this.assets.fetch(
      `https://vinext.invalid${STATIC_ASSET_CACHE_PATH}/${id}.${extension}`,
    );
    if (!bodyResponse.ok) return null;

    let value: CachedAppPageValue | CachedRouteValue;
    if (metadata.kind === "html") {
      value = {
        kind: "APP_PAGE",
        html: await bodyResponse.text(),
        rscData: undefined,
        headers: metadata.headers,
        postponed: undefined,
        status: metadata.status,
      };
    } else if (metadata.kind === "rsc") {
      value = {
        kind: "APP_PAGE",
        html: "",
        rscData: await bodyResponse.arrayBuffer(),
        headers: undefined,
        postponed: undefined,
        status: undefined,
      };
    } else {
      value = {
        kind: "APP_ROUTE",
        body: await bodyResponse.arrayBuffer(),
        headers: metadata.headers ?? {},
        status: metadata.status ?? 200,
      };
    }

    return {
      lastModified: metadata.lastModified,
      ...(metadata.cacheControl ? { cacheControl: metadata.cacheControl } : {}),
      value,
    };
  }

  async set(
    _key: string,
    _data: IncrementalCacheValue | null,
    _ctx?: Record<string, unknown>,
  ): Promise<void> {}

  buildResponseHeaders(input: CdnCacheableHeaderInput): CdnResponseHeaders {
    return {
      "Cache-Control": input.pendingDynamicCheck ? "no-store, must-revalidate" : input.cacheControl,
    };
  }

  buildResponseIdentityHeaders(): CdnResponseHeaders {
    const buildId = process.env.__VINEXT_RSC_BUILD_IDENTITY || process.env.__VINEXT_BUILD_ID;
    return buildId ? { "X-Vinext-Build-Id": buildId } : {};
  }

  async revalidateTag(_tags: string | string[], _durations?: { expire?: number }): Promise<void> {}
}

export default function createStaticAssetsCacheAdapter({
  env,
  options,
}: {
  env?: Record<string, unknown>;
  options?: StaticAssetsAdapterOptions;
} = {}): CdnCacheAdapter {
  const binding = options?.binding ?? "ASSETS";
  const assets = env?.[binding];
  if (
    !assets ||
    typeof assets !== "object" ||
    !("fetch" in assets) ||
    typeof assets.fetch !== "function"
  ) {
    throw new Error(`[vinext] Static Assets binding \`${binding}\` is not configured.`);
  }
  return new StaticAssetsCacheAdapter(assets as AssetFetcher);
}
