/**
 * Config-driven cache adapter tests.
 *
 * Covers:
 *  - generateCacheAdaptersModule() codegen for the `virtual:vinext-cache-adapters`
 *    module across the no-config / data-only / cdn-only / both permutations,
 *    including inlined descriptor options.
 *  - The Cloudflare adapter modules: their config-time builders (kvDataAdapter,
 *    cdnAdapter) and their runtime factory default exports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vite-plus/test";
import {
  generateCacheAdaptersModule,
  VIRTUAL_CACHE_ADAPTERS,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateServerEntry } from "../packages/vinext/src/entries/pages-server-entry.js";
import { generatePagesRouterWorkerEntry } from "../packages/vinext/src/init-cloudflare.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import { kvDataAdapter } from "../packages/cloudflare/src/cache/kv-data-adapter.js";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import { kvCdnAdapter } from "../packages/cloudflare/src/cache/kv-cdn-adapter.js";
import { noCdnCacheAdapter } from "../packages/cloudflare/src/cache/no-cdn-adapter.js";
import createKvDataCacheAdapter, {
  KVCacheHandler,
} from "../packages/cloudflare/src/cache/kv-data-adapter.runtime.js";
import createCloudflareCdnCacheAdapter, {
  CloudflareCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import createKvCdnCacheAdapter, {
  KvCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/kv-cdn-adapter.runtime.js";
import createNoCdnCacheAdapter, {
  NoCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/no-cdn-adapter.runtime.js";

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
    expect(code).toContain(`import { setDataCacheHandler } from "vinext/shims/cache-handler";`);
    expect(code).toContain(
      "setDataCacheHandler(__vinextDataAdapterFactory({ env, options: undefined }));",
    );
    expect(code).not.toContain("__vinextCdnAdapterFactory");
    expect(code).not.toContain("setCdnCacheAdapter");
  });

  it("wires only the cdn adapter when only cdn is configured", () => {
    const code = generateCacheAdaptersModule({ cdn: { adapter: "my-cdn-adapter" } });
    expect(code).toContain(`import __vinextCdnAdapterFactory from "my-cdn-adapter";`);
    expect(code).toContain(`import { setCdnCacheAdapter } from "vinext/shims/cdn-cache";`);
    expect(code).toContain(
      "setCdnCacheAdapter(__vinextCdnAdapterFactory({ env, options: undefined }));",
    );
    expect(code).not.toContain("__vinextDataAdapterFactory");
    expect(code).not.toContain("setDataCacheHandler");
  });

  it("inlines descriptor options and forwards them to the factory", () => {
    const code = generateCacheAdaptersModule({
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter", options: { binding: "MY_KV" } },
    });
    expect(code).toContain(
      `setDataCacheHandler(__vinextDataAdapterFactory({ env, options: {"binding":"MY_KV"} }));`,
    );
  });

  it("wires both adapters and guards against double registration", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "@vinext/cloudflare/cache/cdn-adapter" },
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter" },
    });
    expect(code).toContain(`from "@vinext/cloudflare/cache/cdn-adapter";`);
    expect(code).toContain(`from "@vinext/cloudflare/cache/kv-data-adapter";`);
    expect(code).toContain("setDataCacheHandler(__vinextDataAdapterFactory(");
    expect(code).toContain("setCdnCacheAdapter(__vinextCdnAdapterFactory(");
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

describe("kvDataAdapter builder", () => {
  it("resolves the runtime factory to an absolute path without touching the Workers runtime", () => {
    const descriptor = kvDataAdapter({ binding: "MY_KV", ttlSeconds: 60 });
    // `adapter` is an absolute path to the sibling runtime module (require.resolve),
    // NOT a bare specifier — so it resolves regardless of package export wiring.
    expect(path.isAbsolute(descriptor.adapter)).toBe(true);
    expect(descriptor.adapter.endsWith("kv-data-adapter.runtime.js")).toBe(true);
    expect(descriptor.options).toEqual({ binding: "MY_KV", ttlSeconds: 60 });
    expect(kvDataAdapter().options).toBeUndefined();
  });

  it("validates the binding option at config time", () => {
    // @ts-expect-error — binding must be a string
    expect(() => kvDataAdapter({ binding: 123 })).toThrow(/binding/);
  });
});

describe("kvCdnAdapter builder", () => {
  it("returns a serializable runtime descriptor", () => {
    const descriptor = kvCdnAdapter({ binding: "MY_KV", ttlSeconds: 60 });
    expect(descriptor.options).toEqual({ binding: "MY_KV", ttlSeconds: 60 });
    expect(descriptor.adapter.endsWith("kv-cdn-adapter.runtime.js")).toBe(true);
  });
});

describe("KV CDN cache adapter", () => {
  it("uses the configured KV namespace for page artifacts", async () => {
    const entries = new Map<string, string>();
    const namespace = {
      get: async (key: string) => entries.get(key) ?? null,
      put: async (key: string, value: string) => void entries.set(key, value),
      delete: async (key: string) => void entries.delete(key),
      list: async () => ({ keys: [], list_complete: true }),
    };
    const adapter = createKvCdnCacheAdapter({
      env: { PAGE_KV: namespace },
      options: { binding: "PAGE_KV" },
    });
    expect(adapter).toBeInstanceOf(KvCdnCacheAdapter);
    await adapter.set("page", { kind: "REDIRECT", props: { url: "/target", status: 307 } });
    expect(await adapter.get("page")).toMatchObject({ value: { kind: "REDIRECT" } });
  });
});

describe("Cloudflare kv-data-adapter factory", () => {
  const namespace = { get: async () => null, put: async () => {}, delete: async () => {} };

  it("returns a KVCacheHandler bound to the default VINEXT_KV_CACHE namespace", () => {
    const handler = createKvDataCacheAdapter({
      env: { VINEXT_KV_CACHE: namespace },
      options: undefined,
    });
    expect(handler).toBeInstanceOf(KVCacheHandler);
  });

  it("honors a custom binding name from descriptor options", () => {
    const handler = createKvDataCacheAdapter({
      env: { MY_KV: namespace },
      options: { binding: "MY_KV" },
    });
    expect(handler).toBeInstanceOf(KVCacheHandler);
  });

  it("throws a helpful error when the configured binding is missing", () => {
    expect(() => createKvDataCacheAdapter({ env: {}, options: undefined })).toThrow(
      /VINEXT_KV_CACHE/,
    );
    expect(() =>
      createKvDataCacheAdapter({ env: { OTHER: namespace }, options: { binding: "MY_KV" } }),
    ).toThrow(/`MY_KV` KV namespace binding/);
    expect(() => createKvDataCacheAdapter({ env: undefined, options: undefined })).toThrow(
      /KV namespace binding/,
    );
  });
});

describe("registration is wired into every router/runtime entry", () => {
  const minimalAppRoutes = [
    {
      pattern: "/",
      patternParts: [],
      pagePath: "/tmp/test/app/page.tsx",
      routePath: null,
      layouts: ["/tmp/test/app/layout.tsx"],
      templates: [],
      parallelSlots: [],
      loadingPath: null,
      errorPath: null,
      layoutErrorPaths: [null],
      notFoundPath: null,
      notFoundPaths: [null],
      forbiddenPaths: [null],
      forbiddenPath: null,
      unauthorizedPaths: [null],
      unauthorizedPath: null,
      routeSegments: [],
      templateTreePositions: [],
      layoutTreePositions: [0],
      isDynamic: false,
      params: [],
    },
  ] as unknown as Parameters<typeof generateRscEntry>[1];

  it("App Router RSC entry imports and passes the registrar to the shared handler", () => {
    // The RSC handler is the single chokepoint for App Router on Workers, Node,
    // and dev — wiring registration here covers all three.
    const code = generateRscEntry("/tmp/test/app", minimalAppRoutes, null, [], null, "", false);
    expect(code).toContain('from "virtual:vinext-cache-adapters"');
    expect(code).toContain("registerCacheAdapters: __registerConfiguredCacheAdapters");
  });

  it("Pages Router server entry registers in renderPage and handleApiRoute", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cache-pages-entry-"));
    try {
      const pagesDir = path.join(tmpDir, "pages");
      fs.mkdirSync(pagesDir, { recursive: true });
      fs.writeFileSync(
        path.join(pagesDir, "index.tsx"),
        "export default function Page() { return null; }",
      );
      const code = await generateServerEntry(
        pagesDir,
        await resolveNextConfig({}),
        createValidFileMatcher(),
        null,
        null,
      );
      expect(code).toContain('from "virtual:vinext-cache-adapters"');
      // Called from both request handlers (covers Node, dev, and Workers).
      const calls = code.split("__registerConfiguredCacheAdapters();").length - 1;
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Pages Router worker entry registers with env", () => {
    const code = generatePagesRouterWorkerEntry();
    expect(code).toContain('from "virtual:vinext-cache-adapters"');
    expect(code).toContain("registerConfiguredCacheAdapters(env)");
  });
});

describe("cdnAdapter builder + factory", () => {
  it("builder resolves the runtime factory to an absolute path", () => {
    const descriptor = cdnAdapter();
    expect(path.isAbsolute(descriptor.adapter)).toBe(true);
    expect(descriptor.adapter.endsWith("cdn-adapter.runtime.js")).toBe(true);
    expect(descriptor.options).toBeUndefined();
  });

  it("factory returns a CloudflareCdnCacheAdapter", () => {
    const adapter = createCloudflareCdnCacheAdapter();
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
    // Edge adapter does not own in-process background regeneration.
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });
});

describe("noCdnCacheAdapter builder + factory", () => {
  it("builder resolves the runtime factory to an absolute path", () => {
    const descriptor = noCdnCacheAdapter();
    expect(path.isAbsolute(descriptor.adapter)).toBe(true);
    expect(descriptor.adapter.endsWith("no-cdn-adapter.runtime.js")).toBe(true);
  });

  it("disables storage and cacheable response headers", async () => {
    const adapter = createNoCdnCacheAdapter();
    expect(adapter).toBeInstanceOf(NoCdnCacheAdapter);
    expect(await adapter.get("page")).toBeNull();
    await expect(adapter.set("page", null)).resolves.toBeUndefined();
    expect(
      adapter.buildResponseHeaders({ cacheControl: "s-maxage=60, stale-while-revalidate" }),
    ).toEqual({
      "Cache-Control": "no-store",
      "CDN-Cache-Control": null,
      "Cache-Tag": null,
    });
  });
});
