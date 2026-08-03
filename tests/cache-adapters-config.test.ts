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
import { parseAst } from "vite";
import { describe, it, expect, vi } from "vite-plus/test";
import {
  findVinextCacheConfigInPlugins,
  loadVinextCacheConfigFromViteConfig,
  generateCacheAdaptersModule,
  VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY,
  VIRTUAL_CACHE_ADAPTERS,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateServerEntry } from "../packages/vinext/src/entries/pages-server-entry.js";
import { readPagesRouterEntrySource } from "./worker-entry-source.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import { kvDataAdapter } from "../packages/cloudflare/src/cache/kv-data-adapter.js";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import createKvDataCacheAdapter, {
  KVCacheHandler,
} from "../packages/cloudflare/src/cache/kv-data-adapter.runtime.js";
import createCloudflareCdnCacheAdapter, {
  CloudflareCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";
import {
  deactivateGeneratedCdnCacheAdapter,
  getCdnCacheAdapter,
  hasCdnCacheAdapterRegistrationFailed,
  isConfiguredCdnCacheAdapterActive,
  markCdnCacheAdapterRegistrationFailed,
  setCdnCacheAdapter,
  setConfiguredCdnCacheAdapter,
} from "../packages/vinext/src/shims/cdn-cache.js";
import {
  deactivateGeneratedDataCacheHandler,
  getDataCacheHandler,
  hasDataCacheAdapterRegistrationFailed,
  isConfiguredDataCacheHandlerActive,
  markDataCacheAdapterRegistrationFailed,
  MemoryCacheHandler,
  setConfiguredDataCacheHandler,
  setDataCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";

describe("generateCacheAdaptersModule", () => {
  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_CACHE_ADAPTERS).toBe("virtual:vinext-cache-adapters");
  });

  it("clears stale generated state when no adapters are configured", () => {
    for (const cache of [undefined, {}, { cdn: undefined, data: undefined }]) {
      const code = generateCacheAdaptersModule(cache);
      expect(code).toContain("export function registerConfiguredCacheAdapters() {");
      expect(code).toContain("deactivateGeneratedDataCacheHandler();");
      expect(code).toContain("deactivateGeneratedCdnCacheAdapter();");
      expect(code).toContain('from "vinext/shims/cache-adapter-registration"');
      expect(code).not.toContain('from "vinext/shims/cache-handler"');
      expect(code).not.toContain('from "vinext/shims/cdn-cache"');
      expect(code).toContain(
        "if (typeof process !== 'undefined' && process.env?.__VINEXT_PRERENDER_PATH_DISCOVERY === '1') return;",
      );
      expect(code).not.toContain("setDataCacheHandler");
      expect(code).not.toContain("setCdnCacheAdapter");
    }
  });

  it("wires only the data adapter when only data is configured", () => {
    const code = generateCacheAdaptersModule({ data: { adapter: "my-data-adapter" } });
    expect(code).toContain(`import __vinextDataAdapterFactory from "my-data-adapter";`);
    expect(code).toContain("isConfiguredDataCacheHandlerActive");
    expect(code).toContain(
      "setConfiguredDataCacheHandler(__vinextDataAdapterFactory({ env, options: undefined })",
    );
    expect(code).not.toContain("__vinextCdnAdapterFactory");
    expect(code).not.toContain("setCdnCacheAdapter");
    expect(code).toContain("deactivateGeneratedCdnCacheAdapter();");
    expect(code).not.toContain('from "vinext/shims/cdn-cache"');
  });

  it("wires only the cdn adapter when only cdn is configured", () => {
    const code = generateCacheAdaptersModule({ cdn: { adapter: "my-cdn-adapter" } });
    expect(code).toContain(`import __vinextCdnAdapterFactory from "my-cdn-adapter";`);
    expect(code).toContain("isConfiguredCdnCacheAdapterActive");
    expect(code).toContain(
      "setConfiguredCdnCacheAdapter(__vinextCdnAdapterFactory({ env, options: undefined })",
    );
    expect(code).not.toContain("__vinextDataAdapterFactory");
    expect(code).not.toContain("setDataCacheHandler");
    expect(code).toContain("deactivateGeneratedDataCacheHandler();");
    expect(code).not.toContain('from "vinext/shims/cache-handler"');
  });

  it("inlines descriptor options and forwards them to the factory", () => {
    const code = generateCacheAdaptersModule({
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter", options: { binding: "MY_KV" } },
    });
    expect(code).toContain(
      `setConfiguredDataCacheHandler(__vinextDataAdapterFactory({ env, options: {"binding":"MY_KV"} })`,
    );
  });

  it("wires both adapters and guards against double registration", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "@vinext/cloudflare/cache/cdn-adapter" },
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter" },
    });
    expect(code).toContain(`from "@vinext/cloudflare/cache/cdn-adapter";`);
    expect(code).toContain(`from "@vinext/cloudflare/cache/kv-data-adapter";`);
    expect(code).toContain("setConfiguredDataCacheHandler(__vinextDataAdapterFactory(");
    expect(code).toContain("setConfiguredCdnCacheAdapter(__vinextCdnAdapterFactory(");
    expect(code).toContain("isConfiguredDataCacheHandlerActive(dataRegistrationId, env)");
    expect(code).toContain("isConfiguredCdnCacheAdapterActive(cdnRegistrationId, env)");
    expect(code).toContain("deactivateGeneratedDataCacheHandler();");
    expect(code).toContain("deactivateGeneratedCdnCacheAdapter();");
    expect(() => parseAst(code)).not.toThrow();
    expect(code).toContain(
      "if (typeof process !== 'undefined' && process.env?.__VINEXT_PRERENDER_PATH_DISCOVERY === '1') return;",
    );
    expect(code).not.toContain("__vinextCacheAdaptersRegistered");
  });

  it("deduplicates stateful adapters by build and environment identity", () => {
    const adapterKey = Symbol.for("vinext.cdnCacheAdapter");
    const registrationKey = Symbol.for("vinext.configuredCdnCacheAdapter");
    const failedRegistrationKey = Symbol.for("vinext.failedCdnCacheAdapterRegistrations");
    const env = {};
    const factory = vi.fn(() => new CloudflareCdnCacheAdapter());
    const register = (id: string, registrationEnv: object) => {
      if (
        !isConfiguredCdnCacheAdapterActive(id, registrationEnv) &&
        !hasCdnCacheAdapterRegistrationFailed(id, registrationEnv)
      ) {
        setConfiguredCdnCacheAdapter(factory(), id, registrationEnv);
      }
    };

    try {
      register("build-a", env);
      const first = getCdnCacheAdapter();
      register("build-a", env);
      expect(factory).toHaveBeenCalledOnce();
      expect(getCdnCacheAdapter()).toBe(first);

      const secondEnv = {};
      register("build-a", secondEnv);
      expect(factory).toHaveBeenCalledTimes(2);
      expect(getCdnCacheAdapter()).not.toBe(first);

      register("build-a", env);
      expect(factory).toHaveBeenCalledTimes(3);

      markCdnCacheAdapterRegistrationFailed("failed-build", secondEnv);
      register("failed-build", secondEnv);
      expect(factory).toHaveBeenCalledTimes(3);

      const manual = new CloudflareCdnCacheAdapter();
      setCdnCacheAdapter(manual);
      register("build-a", env);
      expect(factory).toHaveBeenCalledTimes(3);
      expect(getCdnCacheAdapter()).toBe(manual);
    } finally {
      delete (globalThis as Record<PropertyKey, unknown>)[adapterKey];
      delete (globalThis as Record<PropertyKey, unknown>)[registrationKey];
      delete (globalThis as Record<PropertyKey, unknown>)[failedRegistrationKey];
    }
  });

  it("drops generated adapters when a later build removes all or one cache slot", () => {
    const handlerKey = Symbol.for("vinext.cacheHandler");
    const handlerRegistrationKey = Symbol.for("vinext.configuredCacheHandler");
    const adapterKey = Symbol.for("vinext.cdnCacheAdapter");
    const adapterRegistrationKey = Symbol.for("vinext.configuredCdnCacheAdapter");

    try {
      const handlerA = new MemoryCacheHandler();
      const adapterA = new CloudflareCdnCacheAdapter();
      setConfiguredDataCacheHandler(handlerA, "build-a", {});
      setConfiguredCdnCacheAdapter(adapterA, "build-a", {});

      // Build B has no cache config.
      deactivateGeneratedDataCacheHandler();
      deactivateGeneratedCdnCacheAdapter();
      expect(getDataCacheHandler()).not.toBe(handlerA);
      expect(getCdnCacheAdapter()).not.toBe(adapterA);

      // Build C keeps data but removes CDN.
      const handlerC = new MemoryCacheHandler();
      setConfiguredDataCacheHandler(handlerC, "build-c", {});
      setConfiguredCdnCacheAdapter(adapterA, "build-a", {});
      deactivateGeneratedCdnCacheAdapter();
      expect(getDataCacheHandler()).toBe(handlerC);
      expect(getCdnCacheAdapter()).not.toBe(adapterA);

      // Build D keeps CDN but removes data.
      const adapterD = new CloudflareCdnCacheAdapter();
      setConfiguredDataCacheHandler(handlerA, "build-a", {});
      setConfiguredCdnCacheAdapter(adapterD, "build-d", {});
      deactivateGeneratedDataCacheHandler();
      expect(getDataCacheHandler()).not.toBe(handlerA);
      expect(getCdnCacheAdapter()).toBe(adapterD);
    } finally {
      const state = globalThis as Record<PropertyKey, unknown>;
      delete state[handlerKey];
      delete state[handlerRegistrationKey];
      delete state[adapterKey];
      delete state[adapterRegistrationKey];
    }
  });

  it("drops stale generated adapters after a different build or env fails", () => {
    const handlerKey = Symbol.for("vinext.cacheHandler");
    const handlerRegistrationKey = Symbol.for("vinext.configuredCacheHandler");
    const failedHandlerRegistrationKey = Symbol.for("vinext.failedCacheHandlerRegistrations");
    const adapterKey = Symbol.for("vinext.cdnCacheAdapter");
    const adapterRegistrationKey = Symbol.for("vinext.configuredCdnCacheAdapter");
    const failedAdapterRegistrationKey = Symbol.for("vinext.failedCdnCacheAdapterRegistrations");
    const dataFactory = vi.fn((fail: boolean) => {
      if (fail) throw new Error("data factory failed");
      return new MemoryCacheHandler();
    });
    const cdnFactory = vi.fn((fail: boolean) => {
      if (fail) throw new Error("CDN factory failed");
      return new CloudflareCdnCacheAdapter();
    });
    const registerData = (id: string, env: object, fail = false) => {
      if (isConfiguredDataCacheHandlerActive(id, env)) return;
      if (hasDataCacheAdapterRegistrationFailed(id, env)) {
        deactivateGeneratedDataCacheHandler();
        return;
      }
      try {
        setConfiguredDataCacheHandler(dataFactory(fail), id, env);
      } catch {
        markDataCacheAdapterRegistrationFailed(id, env);
        deactivateGeneratedDataCacheHandler();
      }
    };
    const registerCdn = (id: string, env: object, fail = false) => {
      if (isConfiguredCdnCacheAdapterActive(id, env)) return;
      if (hasCdnCacheAdapterRegistrationFailed(id, env)) {
        deactivateGeneratedCdnCacheAdapter();
        return;
      }
      try {
        setConfiguredCdnCacheAdapter(cdnFactory(fail), id, env);
      } catch {
        markCdnCacheAdapterRegistrationFailed(id, env);
        deactivateGeneratedCdnCacheAdapter();
      }
    };

    try {
      const envA = { binding: "a" };
      const envB = { binding: "b" };
      const envC = { binding: "c" };
      registerData("build-a", envA);
      registerCdn("build-a", envA);
      const generatedHandlerA = getDataCacheHandler();
      const generatedAdapterA = getCdnCacheAdapter();

      // A build/env B factory failure must not leave build/env A active.
      registerData("build-b", envB, true);
      registerCdn("build-b", envB, true);
      expect(getDataCacheHandler()).not.toBe(generatedHandlerA);
      expect(getCdnCacheAdapter()).not.toBe(generatedAdapterA);

      // The exact failed identity remains on the safe defaults without retrying.
      registerData("build-b", envB, true);
      registerCdn("build-b", envB, true);
      expect(dataFactory).toHaveBeenCalledTimes(2);
      expect(cdnFactory).toHaveBeenCalledTimes(2);

      // Returning to the failed identity after C succeeds must not expose C either.
      registerData("build-c", envC);
      registerCdn("build-c", envC);
      const generatedHandlerC = getDataCacheHandler();
      const generatedAdapterC = getCdnCacheAdapter();
      registerData("build-b", envB, true);
      registerCdn("build-b", envB, true);
      expect(getDataCacheHandler()).not.toBe(generatedHandlerC);
      expect(getCdnCacheAdapter()).not.toBe(generatedAdapterC);
      expect(dataFactory).toHaveBeenCalledTimes(3);
      expect(cdnFactory).toHaveBeenCalledTimes(3);

      const manualHandler = new MemoryCacheHandler();
      const manualAdapter = new CloudflareCdnCacheAdapter();
      setDataCacheHandler(manualHandler);
      setCdnCacheAdapter(manualAdapter);

      // Direct setters remain authoritative even when generated registration fails.
      registerData("build-b", envB, true);
      registerCdn("build-b", envB, true);
      expect(getDataCacheHandler()).toBe(manualHandler);
      expect(getCdnCacheAdapter()).toBe(manualAdapter);

      // No-config and missing-slot registrars call deactivation unconditionally.
      deactivateGeneratedDataCacheHandler();
      deactivateGeneratedCdnCacheAdapter();
      expect(getDataCacheHandler()).toBe(manualHandler);
      expect(getCdnCacheAdapter()).toBe(manualAdapter);
    } finally {
      const state = globalThis as Record<PropertyKey, unknown>;
      delete state[handlerKey];
      delete state[handlerRegistrationKey];
      delete state[failedHandlerRegistrationKey];
      delete state[adapterKey];
      delete state[adapterRegistrationKey];
      delete state[failedAdapterRegistrationKey];
    }
  });

  it("logs registration failures without printing raw Error stack traces", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "@vinext/cloudflare/cache/cdn-adapter" },
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter" },
    });
    expect(code).toContain("function __vinextFormatAdapterError(error)");
    expect(code).toContain(
      'console.warn("[vinext] failed to initialize the configured data cache adapter; ' +
        'using the default handler.\\n" + __vinextFormatAdapterError(error));',
    );
    expect(code).toContain(
      'console.warn("[vinext] failed to initialize the configured CDN cache adapter; ' +
        'using the default adapter.\\n" + __vinextFormatAdapterError(error));',
    );
    expect(code).not.toContain('", error);');
  });

  it("escapes adapter specifiers so absolute paths are safe", () => {
    // require.resolve() yields an absolute path which may contain characters
    // that must not break the generated import statement.
    const weird = `/tmp/some path/with"quote/adapter.js`;
    const code = generateCacheAdaptersModule({ data: { adapter: weird } });
    expect(code).toContain(`import __vinextDataAdapterFactory from ${JSON.stringify(weird)};`);
  });
});

describe("findVinextCacheConfigInPlugins", () => {
  it("reads cache metadata from nested plugin arrays", async () => {
    const cache = { data: { adapter: "adapter", options: { binding: "MY_KV" } } };
    const plugins = [[{ [VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY]: cache }]] as unknown as Parameters<
      typeof findVinextCacheConfigInPlugins
    >[0];

    expect(await findVinextCacheConfigInPlugins(plugins)).toBe(cache);
  });

  it("reads cache metadata from promised plugin composition", async () => {
    const cache = { data: { adapter: "adapter", options: { binding: "MY_KV" } } };
    const plugins = [
      Promise.resolve([{ [VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY]: cache }]),
    ] as unknown as Parameters<typeof findVinextCacheConfigInPlugins>[0];

    expect(await findVinextCacheConfigInPlugins(plugins)).toBe(cache);
  });

  it("preserves promise-aware cache loading through the internal Vite wrapper", async () => {
    const cache = { data: { adapter: "adapter", options: { binding: "MY_KV" } } };
    const vite = {
      loadConfigFromFile: async () => ({
        config: {
          plugins: [Promise.resolve({ [VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY]: cache })],
        },
      }),
    } as never;

    await expect(loadVinextCacheConfigFromViteConfig(vite, "/tmp/app")).resolves.toBe(cache);
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

  it("Pages Router server entry exports startup registration and reuses request env", async () => {
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
      expect(code).toContain("export function registerConfiguredCacheAdapters(env)");
      const calls = code.split("registerConfiguredCacheAdapters(ctx?.cacheAdapterEnv)").length - 1;
      expect(calls).toBe(2);
      const prodServer = fs.readFileSync(
        path.join(process.cwd(), "packages/vinext/src/server/prod-server.ts"),
        "utf8",
      );
      expect(prodServer).toContain('typeof registerConfiguredCacheAdapters === "function"');
      expect(prodServer).toContain("registerConfiguredCacheAdapters();");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("Pages Router worker entry registers with env", () => {
    const code = readPagesRouterEntrySource();
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
