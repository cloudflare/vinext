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
import vinext from "../packages/vinext/src/index.js";
import {
  findVinextCacheConfigInPlugins,
  loadVinextCacheConfigFromViteConfig,
  generateCacheAdaptersModule,
  resolveControlledResponseVaryHeaders,
  resolveRscCacheKeyMode,
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
import * as internalCacheAdapters from "../packages/vinext/src/cache-adapters.js";

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
    expect(code).toContain(
      "if (typeof process !== 'undefined' && process.env?.__VINEXT_PRERENDER_PATH_DISCOVERY === '1') return;",
    );
    expect(code).toContain('Symbol.for("vinext.cacheAdaptersRegistration")');
    expect(code).toContain(
      "__vinextCacheAdaptersGlobal[__vinextCacheAdaptersRegistrationKey] === __vinextCacheAdaptersRegistrationId",
    );
    expect(code).toContain(
      "__vinextCacheAdaptersGlobal[__vinextCacheAdaptersRegistrationKey] = __vinextCacheAdaptersRegistrationId;",
    );
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

  it("fails closed when CDN adapter capabilities affect the compiled protocol", () => {
    for (const capabilities of [
      { responseVary: "verbatim" as const },
      { controlledResponseVaryHeaders: ["X-Forwarded-Proto"] },
    ]) {
      const code = generateCacheAdaptersModule({
        cdn: { adapter: "capability-cdn-adapter", capabilities },
      });

      expect(code).toContain(
        "delete __vinextCacheAdaptersGlobal[__vinextCacheAdaptersRegistrationKey];",
      );
      expect(code).toContain("the declared cache capabilities require it");
      expect(code).toContain("{ cause: error }");
      expect(code).not.toContain("using the default adapter");
    }
  });

  it("escapes adapter specifiers so absolute paths are safe", () => {
    // require.resolve() yields an absolute path which may contain characters
    // that must not break the generated import statement.
    const weird = `/tmp/some path/with"quote/adapter.js`;
    const code = generateCacheAdaptersModule({ data: { adapter: weird } });
    expect(code).toContain(`import __vinextDataAdapterFactory from ${JSON.stringify(weird)};`);
  });
});

describe("cache adapter capabilities", () => {
  it("preserves the existing internal cache-adapter export surface", () => {
    expect(internalCacheAdapters).toMatchObject({
      VIRTUAL_CACHE_ADAPTERS,
      VINEXT_CACHE_CONFIG_PLUGIN_PROPERTY,
      generateCacheAdaptersModule,
      loadVinextCacheConfigFromViteConfig,
    });
  });

  it("keeps URL header digests unless the CDN adapter guarantees verbatim Vary", () => {
    expect(resolveRscCacheKeyMode()).toBe("header-digest");
    expect(
      resolveRscCacheKeyMode({
        cdn: { adapter: "custom", capabilities: { responseVary: "verbatim" } },
      }),
    ).toBe("response-vary");
  });

  it("rejects protocol-affecting CDN capabilities without an adapter", () => {
    for (const capabilities of [
      { responseVary: "verbatim" as const },
      { controlledResponseVaryHeaders: ["X-Forwarded-Proto"] },
    ]) {
      const cache = { cdn: { adapter: "", capabilities } };
      expect(() => resolveRscCacheKeyMode(cache)).toThrow(/require a configured adapter/);
      expect(() => generateCacheAdaptersModule(cache)).toThrow(/require a configured adapter/);
    }
  });

  it("normalizes adapter-owned response Vary fields for prerender admission", () => {
    expect(
      resolveControlledResponseVaryHeaders({
        cdn: {
          adapter: "custom",
          capabilities: {
            controlledResponseVaryHeaders: [
              " X-Forwarded-Proto ",
              "x-forwarded-proto",
              "invalid header",
            ],
          },
        },
      }),
    ).toEqual(["X-Forwarded-Proto"]);
  });

  it("compiles the Cloudflare capability into the shared browser/server protocol", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vinext-cache-capability-"));
    try {
      fs.mkdirSync(path.join(root, "pages"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "pages", "index.tsx"),
        "export default function Page() { return null; }",
      );
      const plugins = vinext({
        cache: { cdn: cdnAdapter() },
        disableAppRouter: true,
      }) as Array<{
        name?: string;
        config?: (
          config: import("vite").UserConfig,
          env: import("vite").ConfigEnv,
        ) => import("vite").UserConfig | Promise<import("vite").UserConfig>;
      }>;
      const configPlugin = plugins.find((plugin) => plugin.name === "vinext:config");
      const result = await configPlugin?.config?.(
        { root, plugins: [] },
        { command: "build", mode: "production" },
      );

      expect(result?.define?.["process.env.__VINEXT_RSC_CACHE_KEY_MODE"]).toBe(
        JSON.stringify("response-vary"),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
    expect(descriptor.capabilities).toEqual({
      responseVary: "verbatim",
      controlledResponseVaryHeaders: ["X-Forwarded-Proto"],
    });
  });

  it("factory returns a CloudflareCdnCacheAdapter", () => {
    const adapter = createCloudflareCdnCacheAdapter();
    expect(adapter).toBeInstanceOf(CloudflareCdnCacheAdapter);
    // Edge adapter does not own in-process background regeneration.
    expect(adapter.ownsBackgroundRevalidation).toBe(false);
  });
});
