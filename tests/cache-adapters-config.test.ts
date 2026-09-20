/**
 * Config-driven cache adapter tests.
 *
 * Covers:
 *  - generateCacheAdaptersModule() codegen for the `virtual:vinext-cache-adapters`
 *    module across the no-config / data-only / cdn-only / both permutations,
 *    including inlined descriptor options.
 *  - The `requiresEnv` descriptor flag: the emitted env guard for slots that
 *    cannot exist off-Workers, and the runtime behaviour of the generated
 *    registrar on an env-less caller (the Node build/start warning regression).
 *  - The Cloudflare adapter modules: their config-time builders (kvDataAdapter,
 *    cdnAdapter) and their runtime factory default exports.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeEach, describe, it, expect, vi } from "vite-plus/test";
import {
  findVinextCacheConfigInPlugins,
  generateCdnCacheAdapterModule,
  loadVinextCacheConfigFromViteConfig,
  generateCacheAdaptersModule,
  isConfiguredCdnResponsePolicyHeader,
  hasBuildIdentityResponseHeader,
  hasUncachedRequestRouting,
  hasVerbatimResponseVary,
  supportsCanonicalRscWarmup,
  VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY,
  VIRTUAL_CACHE_ADAPTERS,
  VIRTUAL_CDN_CACHE_ADAPTER,
} from "../packages/vinext/src/cache/cache-adapters-virtual.js";
import {
  getDataCacheHandler,
  MemoryCacheHandler,
} from "../packages/vinext/src/shims/cache-handler.js";
import { generateRscEntry } from "../packages/vinext/src/entries/app-rsc-entry.js";
import { generateServerEntry } from "../packages/vinext/src/entries/pages-server-entry.js";
import {
  readAppRequestStageEntrySource,
  readAppRouterEntrySource,
  readPagesRequestStageEntrySource,
} from "./worker-entry-source.js";
import { resolveNextConfig } from "../packages/vinext/src/config/next-config.js";
import { createValidFileMatcher } from "../packages/vinext/src/routing/file-matcher.js";
import { kvDataAdapter } from "../packages/cloudflare/src/cache/kv-data-adapter.js";
import { cdnAdapter } from "../packages/cloudflare/src/cache/cdn-adapter.js";
import { responseStoreAdapter } from "../packages/cloudflare/src/cache/response-store-adapter.js";
import createKvDataCacheAdapter, {
  KVCacheHandler,
} from "../packages/cloudflare/src/cache/kv-data-adapter.runtime.js";
import createCloudflareCdnCacheAdapter, {
  CloudflareCdnCacheAdapter,
} from "../packages/cloudflare/src/cache/cdn-adapter.runtime.js";

describe("generateCacheAdaptersModule", () => {
  // Frozen generated shape of a slot whose descriptor sets `requiresEnv: true`:
  // the whole try/catch is nested one level deeper inside an env guard, so an
  // env-less caller (Node build/start) never even invokes the factory.
  const guardedDataRegistration = [
    "  if (env != null) {",
    "    try {",
    "      registerDataCacheHandler(() => __vinextDataAdapterFactory({ env, options: undefined }));",
    "    } catch (error) {",
    '      console.warn("[vinext] failed to initialize the configured data cache adapter; ' +
      'using the default handler.\\n" + __vinextFormatAdapterError(error));',
    "    }",
    "  }",
  ].join("\n");
  const guardedCdnRegistration = [
    "  if (env != null) {",
    "    try {",
    "      registerCdnCacheAdapter(() => __vinextCdnAdapterFactory({ env, options: undefined }));",
    "    } catch (error) {",
    '      console.warn("[vinext] failed to initialize the configured CDN cache adapter; ' +
      'using the default adapter.\\n" + __vinextFormatAdapterError(error));',
    "    }",
    "  }",
  ].join("\n");

  it("exposes the public virtual module id", () => {
    expect(VIRTUAL_CACHE_ADAPTERS).toBe("virtual:vinext-cache-adapters");
  });

  it("emits a CDN-only registrar for request-stage graphs", () => {
    expect(VIRTUAL_CDN_CACHE_ADAPTER).toBe("virtual:vinext-cdn-cache-adapter");
    const code = generateCdnCacheAdapterModule({
      cdn: { adapter: "my-cdn-adapter" },
      data: { adapter: "my-data-adapter" },
    });
    expect(code).toContain(`import __vinextCdnAdapterFactory from "my-cdn-adapter";`);
    expect(code).not.toContain("my-data-adapter");
    expect(code).not.toContain("registerDataCacheHandler");
  });

  it("emits a no-op registrar when no adapters are configured", () => {
    for (const cache of [undefined, {}, { cdn: undefined, data: undefined }]) {
      const code = generateCacheAdaptersModule(cache);
      expect(code).toContain("export function registerConfiguredCacheAdapters() {}");
      expect(code).not.toContain("import");
      expect(code).not.toContain("registerDataCacheHandler");
      expect(code).not.toContain("registerCdnCacheAdapter");
    }
  });

  it("wires only the data adapter when only data is configured", () => {
    const code = generateCacheAdaptersModule({ data: { adapter: "my-data-adapter" } });
    expect(code).toContain(`import __vinextDataAdapterFactory from "my-data-adapter";`);
    expect(code).toContain(
      `import { registerDataCacheHandler } from "vinext/shims/cache-handler";`,
    );
    expect(code).toContain(
      "registerDataCacheHandler(() => __vinextDataAdapterFactory({ env, options: undefined }));",
    );
    expect(code).not.toContain("__vinextCdnAdapterFactory");
    expect(code).not.toContain("registerCdnCacheAdapter");
  });

  it("wires only the cdn adapter when only cdn is configured", () => {
    const code = generateCacheAdaptersModule({ cdn: { adapter: "my-cdn-adapter" } });
    expect(code).toContain(`import __vinextCdnAdapterFactory from "my-cdn-adapter";`);
    expect(code).toContain(
      `import { registerCdnCacheAdapter } from "vinext/shims/cdn-cache-state";`,
    );
    expect(code).toContain(
      "registerCdnCacheAdapter(() => __vinextCdnAdapterFactory({ env, options: undefined }));",
    );
    expect(code).not.toContain("__vinextDataAdapterFactory");
    expect(code).not.toContain("registerDataCacheHandler");
  });

  it("inlines descriptor options and forwards them to the factory", () => {
    const code = generateCacheAdaptersModule({
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter", options: { binding: "MY_KV" } },
    });
    expect(code).toContain(
      `registerDataCacheHandler(() => __vinextDataAdapterFactory({ env, options: {"binding":"MY_KV"} }));`,
    );
  });

  it("wires both adapters and guards against double registration", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "@vinext/cloudflare/cache/cdn-adapter" },
      data: { adapter: "@vinext/cloudflare/cache/kv-data-adapter" },
    });
    expect(code).toContain(`from "@vinext/cloudflare/cache/cdn-adapter";`);
    expect(code).toContain(`from "@vinext/cloudflare/cache/kv-data-adapter";`);
    expect(code).toContain("registerDataCacheHandler(() => __vinextDataAdapterFactory(");
    expect(code).toContain("registerCdnCacheAdapter(() => __vinextCdnAdapterFactory(");
    expect(code).toContain(
      "if (typeof process !== 'undefined' && process.env?.__VINEXT_PRERENDER_PATH_DISCOVERY === '1') return;",
    );
    expect(code).toContain("if (__vinextCacheAdaptersRegistered) return;");
    expect(code).toContain("__vinextCacheAdaptersRegistered = true;");
  });

  it("advertises data-cache availability without importing it into the request stage", () => {
    const code = generateCdnCacheAdapterModule({
      cdn: { adapter: "my-cdn-adapter", options: { shards: 16 } },
      data: { adapter: "my-data-adapter" },
    });

    expect(code).toContain("export const hasConfiguredDataCache = true;");
    expect(code).toContain('export const configuredCdnCacheAdapterOptions = {"shards":16};');
    expect(code).toContain('from "my-cdn-adapter"');
    expect(code).not.toContain("my-data-adapter");
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

  it("skips an env-requiring data adapter when no env is available", () => {
    const code = generateCacheAdaptersModule({
      data: { adapter: "my-data-adapter", requiresEnv: true },
    });

    // Guard, try/catch, and the 6-space registration line form one contiguous block.
    expect(code).toContain(guardedDataRegistration);
    // The guard wraps only the data slot: a single guard, and the function still
    // ends with its own closing brace right after the guard's.
    expect(code.match(/if \(env != null\) \{/g)).toHaveLength(1);
    expect(code.trimEnd().endsWith("  }\n}")).toBe(true);
  });

  it("wraps each env-requiring slot in its own env guard", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "my-cdn-adapter", requiresEnv: true },
      data: { adapter: "my-data-adapter", requiresEnv: true },
    });

    expect(code).toContain(guardedDataRegistration);
    expect(code).toContain(guardedCdnRegistration);
    expect(code.match(/if \(env != null\) \{/g)).toHaveLength(2);
  });

  it("leaves a slot that does not require env unguarded next to a guarded one", () => {
    const code = generateCacheAdaptersModule({
      cdn: { adapter: "my-cdn-adapter" },
      data: { adapter: "my-data-adapter", requiresEnv: true },
    });

    expect(code).toContain(guardedDataRegistration);
    // Leading newline pins the line start: the unguarded slot keeps its 2-space try.
    expect(code).toContain(
      "\n  try {\n    registerCdnCacheAdapter(() => __vinextCdnAdapterFactory({ env, options: undefined }));\n",
    );
    expect(code.match(/if \(env != null\) \{/g)).toHaveLength(1);
  });

  it("keeps today's unguarded registration for adapters without the flag", () => {
    const code = generateCacheAdaptersModule({ data: { adapter: "my-data-adapter" } });

    expect(code).not.toContain("if (env != null)");
    // The registration stays directly in the function body at 4-space indent.
    expect(code).toContain(
      "\n  try {\n    registerDataCacheHandler(() => __vinextDataAdapterFactory({ env, options: undefined }));\n",
    );
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

  it("preserves adapter-owned multi-stage output metadata", async () => {
    const cache = {
      cdn: {
        adapter: "adapter",
        output: { entry: "/adapter/worker.js", type: "multi-stage" as const },
      },
    };
    const plugins = [{ [VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY]: cache }] as unknown as Parameters<
      typeof findVinextCacheConfigInPlugins
    >[0];

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

  it("flags the descriptor as requiring the runtime env", () => {
    // The KV factory reads a Worker binding, which cannot exist off-Workers, so
    // the registrar must skip it rather than warn on every Node build/start.
    expect(kvDataAdapter().requiresEnv).toBe(true);
    expect(kvDataAdapter({ binding: "MY_KV" }).requiresEnv).toBe(true);
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

/**
 * The reported regression lives in the generated module, not in its text: this
 * block builds the real registrar, imports it, and drives it the way the Node
 * build/start path does (no env) and the way a Worker entry does (env).
 */
describe("generated registrar runtime behaviour", () => {
  // The generated module resolves `vinext/shims/cache-handler` to the same
  // source this file imports, and that module keeps its registry on globalThis
  // under Symbol.for() keys. Deleting those keys is the only reliable reset:
  // setDataCacheHandler() marks the handler explicit, which would turn every
  // later declarative registration into a no-op.
  const HANDLER_REGISTRY_KEYS = [
    "vinext.cacheHandler",
    "vinext.configuredCacheHandler",
    "vinext.explicitCacheHandler",
    "vinext.lazyCacheHandler",
  ];

  const STUB_ADAPTER_SOURCE = `export default function createStubAdapter(args) {
  const calls = (globalThis.__vinextStubAdapterCalls ??= []);
  calls.push(args);
  if (!args?.env?.STUB_KV) throw new Error("missing binding");
  const handler = { kind: "stub-cache-handler" };
  globalThis.__vinextStubAdapterHandler = handler;
  return handler;
}
`;

  type StubAdapterCall = { env?: Record<string, unknown>; options?: unknown };
  type StubAdapterGlobals = {
    __vinextStubAdapterCalls?: StubAdapterCall[];
    __vinextStubAdapterHandler?: { kind: string };
  };

  const tmpDirs: string[] = [];

  function stubGlobals(): StubAdapterGlobals {
    return globalThis as unknown as StubAdapterGlobals;
  }

  function stubCalls(): StubAdapterCall[] {
    return stubGlobals().__vinextStubAdapterCalls ?? [];
  }

  function warnCalls(): unknown[][] {
    return vi.mocked(console.warn).mock.calls;
  }

  function resetDataCacheRegistry(): void {
    const globals = globalThis as unknown as Record<PropertyKey, unknown>;
    for (const key of HANDLER_REGISTRY_KEYS) delete globals[Symbol.for(key)];
    delete globals.__vinextStubAdapterCalls;
    delete globals.__vinextStubAdapterHandler;
  }

  beforeEach(() => {
    resetDataCacheRegistry();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build, import, and hand back the generated registrar for one case. Each
   * case needs its own module instance (the registrar self-guards with a
   * module-level flag), and the temp dir lives inside tests/ so Vite's
   * workspace aliases still apply to the generated `vinext/shims/...` import.
   */
  async function loadRegistrar(
    requiresEnv: boolean | undefined,
  ): Promise<(env?: Record<string, unknown>) => void> {
    const dir = fs.mkdtempSync(path.join(import.meta.dirname, "vinext-cache-adapters-"));
    tmpDirs.push(dir);
    const stubPath = path.join(dir, "stub-adapter.mjs");
    fs.writeFileSync(stubPath, STUB_ADAPTER_SOURCE);
    const descriptor =
      requiresEnv === undefined ? { adapter: stubPath } : { adapter: stubPath, requiresEnv };
    const modulePath = path.join(dir, "module.mjs");
    fs.writeFileSync(modulePath, generateCacheAdaptersModule({ data: descriptor }));
    const module = (await import(pathToFileURL(modulePath).href)) as {
      registerConfiguredCacheAdapters: (env?: Record<string, unknown>) => void;
    };
    return module.registerConfiguredCacheAdapters;
  }

  it("skips the factory entirely when an env-requiring adapter runs without env", async () => {
    const register = await loadRegistrar(true);

    register();

    expect(warnCalls()).toHaveLength(0);
    expect(stubCalls()).toHaveLength(0);
    expect(getDataCacheHandler()).toBeInstanceOf(MemoryCacheHandler);
  });

  it("registers the env-requiring adapter when its binding is present", async () => {
    const register = await loadRegistrar(true);
    const env = { STUB_KV: {} };

    register(env);

    expect(warnCalls()).toHaveLength(0);
    expect(stubCalls()).toHaveLength(1);
    expect(stubCalls()[0]?.env).toBe(env);
    expect(getDataCacheHandler()).toBe(stubGlobals().__vinextStubAdapterHandler);
  });

  it("warns and keeps the default handler when the required binding is missing", async () => {
    const register = await loadRegistrar(true);

    register({});

    // The factory is still called — env is present, so the binding is genuinely missing.
    expect(stubCalls()).toHaveLength(1);
    expect(warnCalls()).toHaveLength(1);
    expect(String(warnCalls()[0]?.[0])).toContain(
      "failed to initialize the configured data cache adapter",
    );
    expect(getDataCacheHandler()).toBeInstanceOf(MemoryCacheHandler);
  });

  it("still attempts and warns for adapters that never opted into env", async () => {
    const register = await loadRegistrar(undefined);

    register();

    expect(stubCalls()).toHaveLength(1);
    expect(stubCalls()[0]?.env).toBeUndefined();
    expect(warnCalls()).toHaveLength(1);
    expect(String(warnCalls()[0]?.[0])).toContain(
      "failed to initialize the configured data cache adapter",
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
    const code = readPagesRequestStageEntrySource();
    const eagerCdnRegistration = "configuredCdnCacheAdapters.registerConfiguredCacheAdapters(env);";
    const validateCdnRequest = "await validateCdnRequest(request)";
    const lazyDataRegistration = code.match(
      /registerLazyDataCacheHandler\(async \(\) => \{[\s\S]*?\n\s*\}\);/,
    )?.[0];

    expect(code).toContain('from "virtual:vinext-cdn-cache-adapter"');
    expect(code).not.toContain('from "virtual:vinext-cache-adapters"');
    expect(code).toContain(eagerCdnRegistration);
    expect(code.indexOf(eagerCdnRegistration)).toBeLessThan(code.indexOf(validateCdnRequest));
    expect(lazyDataRegistration).toContain('await import("virtual:vinext-cache-adapters")');
    expect(lazyDataRegistration).toContain("adapters.registerConfiguredCacheAdapters(env);");
  });

  it("App request stage cannot retain the configured data adapter module", () => {
    const code = readAppRequestStageEntrySource();
    expect(code).toContain('from "virtual:vinext-cdn-cache-adapter"');
    expect(code).not.toContain('from "virtual:vinext-cache-adapters"');
  });

  it("App Router worker entry validates CDN routing after registering with env", () => {
    const code = readAppRouterEntrySource();
    expect(code).toContain("registerConfiguredCacheAdapters(env");
    expect(code).toContain("await validateCdnRequest(request)");
    expect(code.indexOf("registerConfiguredCacheAdapters(env")).toBeLessThan(
      code.indexOf("await validateCdnRequest(request)"),
    );
  });
});

describe("cdnAdapter builder + factory", () => {
  it("builder resolves the runtime factory to an absolute path", () => {
    const descriptor = cdnAdapter();
    expect(path.isAbsolute(descriptor.adapter)).toBe(true);
    expect(descriptor.adapter.endsWith("cdn-adapter.runtime.js")).toBe(true);
    expect(descriptor.options).toBeUndefined();
    expect(descriptor.output.type).toBe("multi-stage");
    expect(path.isAbsolute(descriptor.output.entry)).toBe(true);
    expect(descriptor.output.entry.endsWith("cdn-adapter.worker.js")).toBe(true);
    expect(
      descriptor.output.transformHostEntry({
        code: 'import handler from "vinext/server/fetch-handler";\nexport default handler;',
        id: "\0virtual:cloudflare/worker-entry",
      }),
    ).toContain(
      `export { VinextCachedResponse, VinextUncachedResponse } from ${JSON.stringify(descriptor.output.entry)};`,
    );
    expect(
      descriptor.output.transformHostEntry({
        code: "export default { fetch() {} };",
        id: "/app/unrelated.ts",
      }),
    ).toBeNull();
    expect(
      descriptor.output.transformHostEntry({
        code: 'export default function Docs() { return "vinext/server/fetch-handler"; }',
        id: "/app/page.tsx",
      }),
    ).toBeNull();
    expect(
      descriptor.output.transformHostEntry({
        code: '// import handler from "vinext/server/fetch-handler";\nexport default {};',
        id: "/app/page.ts",
      }),
    ).toBeNull();
    expect(descriptor.capabilities).toEqual({
      buildIdentity: "response-header",
      isResponsePolicyHeader: expect.any(Function),
      requestRouting: "uncached-stage",
      responseVary: "verbatim",
      routeCacheability: "probe-manifest",
    });
    expect(hasBuildIdentityResponseHeader({ cdn: descriptor })).toBe(true);
    expect(hasUncachedRequestRouting({ cdn: descriptor })).toBe(true);
    expect(hasVerbatimResponseVary({ cdn: descriptor })).toBe(true);
    expect(hasBuildIdentityResponseHeader({ cdn: { adapter: "custom-cache" } })).toBe(false);
    expect(hasUncachedRequestRouting({ cdn: { adapter: "url-only-cache" } })).toBe(false);
    expect(hasVerbatimResponseVary({ cdn: { adapter: "url-only-cache" } })).toBe(false);
    const custom = {
      cdn: {
        adapter: "custom-cache",
        capabilities: {
          isResponsePolicyHeader: (name: string) =>
            name.trim().toLowerCase() === "x-example-policy",
        },
      },
    };
    expect(isConfiguredCdnResponsePolicyHeader(custom, "Cache-Control")).toBe(true);
    expect(isConfiguredCdnResponsePolicyHeader(custom, " X-Example-Policy ")).toBe(true);
    expect(isConfiguredCdnResponsePolicyHeader(custom, "X-Unrelated")).toBe(false);
  });

  it("factory returns a CloudflareCdnCacheAdapter", () => {
    const adapter = createCloudflareCdnCacheAdapter();
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
    // Edge adapter does not own in-process background regeneration.
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });

  it("forwards a custom version metadata binding", () => {
    expect(cdnAdapter({ versionMetadataBinding: "CUSTOM_VERSION" }).options).toEqual({
      versionMetadataBinding: "CUSTOM_VERSION",
    });
    expect(() => cdnAdapter({ versionMetadataBinding: "" })).toThrow(
      "must be a non-empty string binding name",
    );
  });
});

describe("responseStoreAdapter builder", () => {
  it("declares single-upload, after-render warmup capabilities", () => {
    const descriptor = responseStoreAdapter();
    expect(descriptor.cdn.capabilities).toEqual({
      buildIdentity: "response-header",
      isResponsePolicyHeader: expect.any(Function),
      requestRouting: "uncached-stage",
      warmup: "response-store",
    });
    expect(hasBuildIdentityResponseHeader(descriptor)).toBe(true);
    expect(hasVerbatimResponseVary(descriptor)).toBe(false);
    expect(supportsCanonicalRscWarmup(descriptor)).toBe(false);
  });

  it("can keep Response Store inside the application Worker", () => {
    const descriptor = responseStoreAdapter({ mode: "self-contained" });
    expect(descriptor.cdn.output.entry).toMatch(
      /response-store-adapter\.self-contained\.worker\.js$/,
    );
    expect(
      descriptor.cdn.output.transformHostEntry({
        code: "export default {};",
        id: "virtual:cloudflare/worker-entry",
      }),
    ).toBe(
      `export default {};\nexport { CacheMetadata, ResponseStoreBinding, ResponseStoreRevalidator } from ${JSON.stringify(descriptor.cdn.output.entry)};\n`,
    );
  });

  it("opts into metadata sharding explicitly", () => {
    const descriptor = responseStoreAdapter({ shards: 16 });
    expect(descriptor.cdn.options).toEqual({ shards: 16 });
    expect(descriptor.data.options).toEqual({ shards: 16 });
    expect(responseStoreAdapter().cdn.options).toBeUndefined();
    expect(() => responseStoreAdapter({ shards: 1 })).toThrow(
      "Workers Response Store shards must be an integer greater than 1",
    );
  });
});
