import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  cacheWarmupStatusSource,
  finalizeCacheAdapterPrerenderOutput,
  hasCacheAdapterPrerenderOutput,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import { appIsrCacheKey } from "../packages/vinext/src/server/isr-cache.js";
import { staticAssetsAdapter } from "../packages/cloudflare/src/cache/static-assets-adapter.js";
import createStaticAssetsCacheAdapter, {
  StaticAssetsCacheAdapter,
} from "../packages/cloudflare/src/cache/static-assets-adapter.runtime.js";

describe("staticAssetsAdapter", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-static-assets-cache-"));
    roots.push(root);
    return root;
  }

  function write(root: string, relativePath: string, contents: string): void {
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it("declares a read-only prerender output and validates the binding", () => {
    const descriptor = staticAssetsAdapter({ binding: "STATIC" });
    expect(descriptor.adapter.endsWith("static-assets-adapter.runtime.js")).toBe(true);
    expect(descriptor.options).toEqual({ binding: "STATIC" });
    expect(descriptor.capabilities).toEqual({
      buildIdentity: "response-header",
      warmup: "data-cache",
    });
    expect(hasCacheAdapterPrerenderOutput({ cdn: descriptor })).toBe(true);
    expect(cacheWarmupStatusSource({ cdn: descriptor })).toBe("data-cache");
    expect(() => staticAssetsAdapter({ binding: "" })).toThrow(/non-empty string/);
  });

  it("packages prerendered HTML and RSC and reads them through the Assets binding", async () => {
    const root = createRoot();
    write(
      root,
      "dist/server/vinext-prerender.json",
      JSON.stringify({
        buildId: "build-a",
        routes: [
          {
            route: "/",
            status: "rendered",
            revalidate: false,
            router: "app",
            headers: { "x-prerendered": "yes" },
          },
        ],
      }),
    );
    write(root, "dist/server/prerendered-routes/index.html", "<h1>static</h1>");
    write(root, "dist/server/prerendered-routes/index.rsc", "rsc payload");

    const descriptor = staticAssetsAdapter();
    await finalizeCacheAdapterPrerenderOutput({ cdn: descriptor }, root);

    const assets = {
      async fetch(input: RequestInfo | URL) {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input : input.url,
        );
        const file = path.join(root, "dist/client", url.pathname.replace(/^\//, ""));
        return fs.existsSync(file)
          ? new Response(fs.readFileSync(file))
          : new Response("not found", { status: 404 });
      },
    };
    const adapter = createStaticAssetsCacheAdapter({ env: { ASSETS: assets } });
    expect(adapter).toBeInstanceOf(StaticAssetsCacheAdapter);

    const html = await adapter.get(appIsrCacheKey("/", "html", "build-a"));
    expect(html).toMatchObject({
      cacheControl: { revalidate: false },
      value: {
        kind: "APP_PAGE",
        html: "<h1>static</h1>",
        headers: { "x-prerendered": "yes" },
      },
    });

    const rsc = await adapter.get(appIsrCacheKey("/", "rsc", "build-a"));
    expect(rsc?.value?.kind).toBe("APP_PAGE");
    if (rsc?.value?.kind !== "APP_PAGE") throw new Error("expected APP_PAGE");
    expect(new TextDecoder().decode(rsc.value.rscData)).toBe("rsc payload");

    await expect(adapter.set("missing", null)).resolves.toBeUndefined();
    await expect(adapter.revalidateTag("tag")).resolves.toBeUndefined();
    await expect(adapter.get("missing")).resolves.toBeNull();
  });

  it("fails clearly when the configured Assets binding is missing", () => {
    expect(() => createStaticAssetsCacheAdapter({ env: {} })).toThrow(/`ASSETS`/);
    expect(() =>
      createStaticAssetsCacheAdapter({ env: { ASSETS: {} }, options: { binding: "STATIC" } }),
    ).toThrow(/`STATIC`/);
  });
});
