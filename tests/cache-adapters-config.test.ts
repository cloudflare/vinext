/**
 * Config-driven cache adapter tests.
 *
 * Covers:
 *  - generateCacheAdaptersModule() codegen for the `virtual:vinext-cache-adapters`
 *    module across the no-config / data-only / cdn-only / both permutations.
 *  - The Cloudflare adapter factory modules (kv-data-adapter, cdn-adapter)
 *    pointed at by `cache.data.adapter` / `cache.cdn.adapter`.
 */
import { describe, it, expect } from "vite-plus/test";
import {
  generateCacheAdaptersModule,
  VIRTUAL_CACHE_ADAPTERS,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import createKvDataCacheAdapter from "../packages/vinext/src/cloudflare/cache/kv-data-adapter.js";
import createCloudflareCdnCacheAdapter from "../packages/vinext/src/cloudflare/cache/cdn-adapter.js";
import { KVCacheHandler } from "../packages/vinext/src/cloudflare/kv-cache-handler.js";
import { CloudflareCdnCacheAdapter } from "../packages/vinext/src/cloudflare/cloudflare-cdn-cache.js";

describe("generateCacheAdaptersModule", () => {
  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_CACHE_ADAPTERS).toBe("virtual:vinext-cache-adapters");
  });

  it("emits a no-op registrar when no adapters are configured", () => {
    for (const cache of [undefined, {}, { cdn: undefined, data: undefined }]) {
      const code = generateCacheAdaptersModule(cache);
      expect(code).toContain("export function registerConfiguredCacheAdapters() {}");
      expect(code).not.toContain("import");
      expect(code).not.toContain("setDataCacheHandler");
      expect(code).not.toContain("setCdnCacheAdapter");
    }
  });

  it("wires only the data adapter when only data is configured", () => {
    const code = generateCacheAdaptersModule({ data: { adapter: "my-data-adapter" } });
    expect(code).toContain(`import __vinextDataAdapterFactory from "my-data-adapter";`);
    expect(code).toContain(`import { setDataCacheHandler } from "vinext/shims/cache";`);
    expect(code).toContain("setDataCacheHandler(__vinextDataAdapterFactory(__context));");
    // No CDN wiring.
    expect(code).not.toContain("__vinextCdnAdapterFactory");
    expect(code).not.toContain("setCdnCacheAdapter");
  });

  it("wires only the cdn adapter when only cdn is configured", () => {
    const code = generateCacheAdaptersModule({ cdn: { adapter: "my-cdn-adapter" } });
    expect(code).toContain(`import __vinextCdnAdapterFactory from "my-cdn-adapter";`);
    expect(code).toContain(`import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";`);
    expect(code).toContain("setCdnCacheAdapter(__vinextCdnAdapterFactory(__context));");
    expect(code).not.toContain("__vinextDataAdapterFactory");
    expect(code).not.toContain("setDataCacheHandler");
  });

  it("wires both adapters and guards against double registration", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "@vinext/cloudflare/cache/cdn-adapter" },
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter" },
    });
    expect(code).toContain(`from "@vinext/cloudflare/cache/cdn-adapter";`);
    expect(code).toContain(`from "@vinext/cloudflare/cache/kv-data-adapter";`);
    expect(code).toContain("setDataCacheHandler(__vinextDataAdapterFactory(__context));");
    expect(code).toContain("setCdnCacheAdapter(__vinextCdnAdapterFactory(__context));");
    // Idempotency guard.
    expect(code).toContain("if (__vinextCacheAdaptersRegistered) return;");
    expect(code).toContain("__vinextCacheAdaptersRegistered = true;");
  });

  it("escapes adapter specifiers so absolute paths are safe", () => {
    // require.resolve() yields an absolute path which may contain characters
    // that must not break the generated import statement.
    const weird = `/tmp/some path/with"quote/adapter.js`;
    const code = generateCacheAdaptersModule({ data: { adapter: weird } });
    expect(code).toContain(`import __vinextDataAdapterFactory from ${JSON.stringify(weird)};`);
  });
});

describe("Cloudflare kv-data-adapter factory", () => {
  it("returns a KVCacheHandler bound to the VINEXT_CACHE namespace", () => {
    const namespace = { get: async () => null, put: async () => {}, delete: async () => {} };
    const handler = createKvDataCacheAdapter({ env: { VINEXT_CACHE: namespace } });
    expect(handler).toBeInstanceOf(KVCacheHandler);
  });

  it("throws a helpful error when the VINEXT_CACHE binding is missing", () => {
    expect(() => createKvDataCacheAdapter({ env: {} })).toThrow(/VINEXT_CACHE/);
    expect(() => createKvDataCacheAdapter({ env: undefined })).toThrow(/KV namespace binding/);
  });
});

describe("Cloudflare cdn-adapter factory", () => {
  it("returns a CloudflareCdnCacheAdapter regardless of env", () => {
    const adapter = createCloudflareCdnCacheAdapter({ env: undefined });
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
    // Edge adapter does not own in-process background regeneration.
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });
});
