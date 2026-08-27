import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { createCloudflareFetchAdapter } from "../packages/vinext/src/server/cloudflare-fetch-adapter.js";

const payload = { timestamp: 1_787_056_318 };
const encodedBody = brotliCompressSync(gzipSync(JSON.stringify(payload)));
const networkFetch = vi.fn(
  async () =>
    new Response(encodedBody, {
      headers: {
        "content-encoding": "gzip, br",
        "content-length": String(encodedBody.byteLength),
        "content-type": "application/json",
      },
    }),
);

vi.stubGlobal("fetch", createCloudflareFetchAdapter(networkFetch));

const { withFetchCache } = await import("../packages/vinext/src/shims/fetch-cache.js");
const { MemoryCacheHandler, setCacheHandler } =
  await import("../packages/vinext/src/shims/cache.js");

describe("Cloudflare fetch adapter with fetch cache", () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("caches and replays the fully decoded body with Next-compatible headers", async () => {
    networkFetch.mockClear();
    setCacheHandler(new MemoryCacheHandler());
    cleanup = withFetchCache();

    const cold = await fetch("https://api.example.com/stacked", { cache: "force-cache" });
    expect(cold.headers.get("content-encoding")).toBe("gzip, br");
    await expect(cold.json()).resolves.toEqual(payload);

    const cached = await fetch("https://api.example.com/stacked", { cache: "force-cache" });
    expect(cached.headers.get("content-encoding")).toBe("gzip, br");
    await expect(cached.json()).resolves.toEqual(payload);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  });
});
