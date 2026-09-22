import { describe, expect, it } from "vite-plus/test";
import { parseSync } from "vite";
import vm from "node:vm";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  generateAppRouterViteConfig,
  generatePagesRouterViteConfig,
  generateResponseStoreWranglerConfig,
  generateWranglerConfig,
  getWranglerImagesBinding,
  getWranglerVersionMetadataBinding,
  updateViteConfigForCloudflare,
  updateViteConfigForTailwind,
  updateWranglerConfigForCloudflare,
} from "../packages/vinext/src/init-cloudflare.js";
import { readPagesRouterEntrySource } from "./worker-entry-source.js";

function expectValidConfig(output: string): void {
  const parsed = parseSync("vite.config.ts", output, {
    astType: "ts",
    lang: "ts",
    sourceType: "module",
  });
  expect(parsed.errors.filter((diagnostic) => diagnostic.severity === "Error")).toEqual([]);
}

describe("generateWranglerConfig", () => {
  it.each(["service-binding", "self-contained"] as const)(
    "pretty-prints the generated %s Response Store config",
    (responseStoreMode) => {
      const output = generateWranglerConfig(
        {
          root: "/tmp/my-app",
          projectName: "my-app",
          isAppRouter: true,
          hasISR: true,
          hasMDX: false,
          hasTailwindV4: false,
          nativeModulesToStub: [],
        },
        {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "cloudflare-images",
          responseStoreMode,
        },
        "2026-09-14",
      );

      expect(output).toBe(`${JSON.stringify(JSON.parse(output), null, 2)}\n`);
    },
  );
});

describe("updateViteConfigForCloudflare", () => {
  it("does not configure caching by default", () => {
    const output = generateAppRouterViteConfig();
    expectValidConfig(output);
    expect(output).not.toContain("responseStoreAdapter");
    expect(output).not.toContain("kvDataAdapter");
    expect(output).not.toContain("cdnAdapter");
    expect(output).not.toContain("cache:");
  });

  it("adds Workers Response Store to an existing bare vinext config", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext()] };
`;
    const options = {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none" as const,
        cdnCache: "response-store" as const,
        imageOptimization: "none" as const,
      },
    };
    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);
    expectValidConfig(output);
    expect(output).toContain("vinext({\n    cache: responseStoreAdapter(),\n  })");
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("configures a self-contained Workers Response Store", () => {
    const output = generateAppRouterViteConfig(undefined, {
      dataCache: "none",
      cdnCache: "response-store",
      imageOptimization: "none",
      responseStoreMode: "self-contained",
    });

    expectValidConfig(output);
    expect(output).toContain('cache: responseStoreAdapter({ mode: "self-contained" })');
  });

  it("configures the application and separate Response Store Workers", () => {
    const options = {
      dataCache: "none" as const,
      cdnCache: "response-store" as const,
      imageOptimization: "none" as const,
      responseStoreMode: "service-binding" as const,
    };
    const app = updateWranglerConfigForCloudflare(
      `{ "name": "my-app", "compatibility_date": "2026-09-14", "exports": { "Other": { "type": "worker" } } }\n`,
      options,
      { root: "/tmp/vinext-missing-response-store-config" },
    );
    const appConfig = JSON.parse(app);
    expect(appConfig).toMatchObject({
      cache: { enabled: false },
      services: [
        {
          binding: "RESPONSE_STORE",
          service: "my-app-response-store",
          entrypoint: "ResponseStoreService",
        },
      ],
      version_metadata: { binding: "CF_VERSION_METADATA" },
    });
    expect(appConfig.exports).toEqual({ Other: { type: "worker" } });
    expect(appConfig.r2_buckets).toBeUndefined();
    expect(appConfig.durable_objects).toBeUndefined();

    const service = JSON.parse(
      generateResponseStoreWranglerConfig(app, "/tmp/vinext-missing-response-store-config"),
    );
    expect(service).toMatchObject({
      name: "my-app-response-store",
      main: "./node_modules/@cloudflare/workers-response-store/dist/service.js",
      cache: { enabled: true },
      exports: {
        CacheMetadata: { type: "durable-object", storage: "sqlite" },
      },
      r2_buckets: [{ binding: "CACHE_BODIES", bucket_name: "my-app-response-store-cache-bodies" }],
      durable_objects: {
        bindings: [{ name: "CACHE_METADATA", class_name: "CacheMetadata" }],
      },
    });
    expect(service.migrations).toBeUndefined();
  });

  it("puts Response Store resources on the application only in self-contained mode", () => {
    const selfContained = updateWranglerConfigForCloudflare(
      `{ "name": "my-app", "compatibility_date": "2026-09-14", "exports": { "Other": { "type": "worker" } } }\n`,
      {
        dataCache: "none",
        cdnCache: "response-store",
        imageOptimization: "none",
        responseStoreMode: "self-contained",
      },
      { root: "/tmp/vinext-missing-response-store-config" },
    );
    expect(JSON.parse(selfContained)).toMatchObject({
      cache: { enabled: true },
      exports: {
        Other: { type: "worker", cache: { enabled: false } },
        ResponseStoreBinding: { type: "worker", cache: { enabled: true } },
        CacheMetadata: { type: "durable-object", storage: "sqlite" },
      },
      r2_buckets: [{ binding: "CACHE_BODIES" }],
      durable_objects: {
        bindings: [{ name: "CACHE_METADATA", class_name: "CacheMetadata" }],
      },
    });

    const serviceBinding = JSON.parse(
      updateWranglerConfigForCloudflare(
        selfContained,
        {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
          responseStoreMode: "service-binding",
        },
        { root: "/tmp/vinext-missing-response-store-config" },
      ),
    );
    expect(serviceBinding.cache).toEqual({ enabled: false });
    expect(serviceBinding.exports.ResponseStoreBinding).toBeUndefined();
    expect(serviceBinding.exports.CacheMetadata).toBeUndefined();
    expect(serviceBinding.exports.Other).toEqual({
      type: "worker",
      cache: { enabled: false },
    });
    expect(serviceBinding.r2_buckets).toEqual([]);
    expect(serviceBinding.durable_objects.bindings).toEqual([]);
    expect(serviceBinding.migrations).toBeUndefined();
  });

  it("rejects self-contained mode alongside unrelated Durable Object migrations", () => {
    expect(() =>
      updateWranglerConfigForCloudflare(
        JSON.stringify({
          name: "my-app",
          compatibility_date: "2026-09-14",
          migrations: [{ tag: "v1", new_classes: ["OtherDurableObject"] }],
        }),
        {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
          responseStoreMode: "self-contained",
        },
        { root: "/tmp/vinext-missing-response-store-config" },
      ),
    ).toThrow("cannot be combined with migration-based Durable Objects");
  });

  it("rejects a conflicting Response Store service binding", () => {
    expect(() =>
      updateWranglerConfigForCloudflare(
        `{ "name": "my-app", "services": [{ "binding": "RESPONSE_STORE", "service": "other" }] }\n`,
        {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
          responseStoreMode: "service-binding",
        },
        { root: "/tmp/vinext-missing-response-store-config" },
      ),
    ).toThrow("RESPONSE_STORE service binding uses a different entrypoint");
  });

  it.each([
    [
      "R2",
      { r2_buckets: [{ binding: "CACHE_BODIES", bucket_name: "application-bucket" }] },
      "CACHE_BODIES is already used by an application-owned R2 binding",
    ],
    [
      "Durable Object",
      {
        durable_objects: {
          bindings: [{ name: "CACHE_METADATA", class_name: "ApplicationMetadata" }],
        },
      },
      "CACHE_METADATA is already used by an application-owned Durable Object binding",
    ],
  ])("does not remove an application-owned %s binding", (_kind, bindings, message) => {
    expect(() =>
      updateWranglerConfigForCloudflare(
        JSON.stringify({ name: "my-app", compatibility_date: "2026-09-14", ...bindings }),
        {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
          responseStoreMode: "service-binding",
        },
        { root: "/tmp/vinext-missing-response-store-config" },
      ),
    ).toThrow(message);
  });

  it("updates the mode of an existing Workers Response Store", () => {
    const input = `import vinext from "vinext";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
export default { plugins: [vinext({ cache: responseStoreAdapter() })] };
`;
    const options = {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none" as const,
        cdnCache: "response-store" as const,
        imageOptimization: "none" as const,
        responseStoreMode: "self-contained" as const,
      },
    };

    const selfContained = updateViteConfigForCloudflare("vite.config.ts", input, options);
    expect(selfContained).toContain('cache: responseStoreAdapter({ mode: "self-contained" })');
    const serviceBinding = updateViteConfigForCloudflare("vite.config.ts", selfContained, {
      ...options,
      cache: { ...options.cache, responseStoreMode: "service-binding" },
    });
    expect(serviceBinding).toContain('cache: responseStoreAdapter({ mode: "service-binding" })');
  });

  it("expands a shorthand Response Store mode when updating it", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
const mode = "service-binding";
export default { plugins: [vinext({ cache: responseStoreAdapter({ mode }) }), cloudflare()] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none",
        cdnCache: "response-store",
        imageOptimization: "none",
        responseStoreMode: "self-contained",
      },
    });

    expectValidConfig(output);
    expect(output).toContain('responseStoreAdapter({ mode: "self-contained" })');
  });

  it("preserves Response Store sharding when updating its deployment mode", () => {
    const input = `import vinext from "vinext";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
export default { plugins: [vinext({ cache: responseStoreAdapter({ shards: 16 }) })] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none",
        cdnCache: "response-store",
        imageOptimization: "none",
        responseStoreMode: "self-contained",
      },
    });

    expectValidConfig(output);
    expect(output).toMatch(
      /responseStoreAdapter\(\{\s*shards:\s*16\s*,\s*mode:\s*"self-contained"/,
    );
  });

  it("rejects disabling an existing cache configuration without removing it", () => {
    const input = `import vinext from "vinext";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
export default { plugins: [vinext({ cache: responseStoreAdapter() })] };
`;

    expect(() =>
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "none",
          imageOptimization: "none",
        },
      }),
    ).toThrow("does not match the selected cache options");
  });

  it("rejects disabling an existing data cache without removing it", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext({ cache: { data: customData() } })] };
`;

    expect(() =>
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "none",
          imageOptimization: "none",
        },
      }),
    ).toThrow("does not match the selected cache options");
  });

  it("rejects replacing an existing cache configuration with Workers Response Store", () => {
    const input = `import vinext from "vinext";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
export default { plugins: [vinext({ cache: { cdn: cdnAdapter() } })] };
`;

    expect(() =>
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
        },
      }),
    ).toThrow(
      "The vinext() cache option is already configured. Remove it before configuring Workers Response Store.",
    );
  });

  it("updates an existing ESM App Router config without replacing user code", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import custom from "./custom.js";

export default defineConfig({
  plugins: [custom(), vinext()],
  server: { port: 4000 },
});
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: true,
      nativeModulesToStub: [],
    });

    expect(output).toContain('import custom from "./custom.js"');
    expect(output).toContain("server: { port: 4000 }");
    expect(output).toContain('import { cloudflare } from "@cloudflare/vite-plugin"');
    expect(output).toContain('childEnvironments: ["ssr"]');
  });

  it("adds viteEnvironment to an existing bare cloudflare() call", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [vinext(), cloudflare()],
});
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: true,
      nativeModulesToStub: [],
    });

    expectValidConfig(output);
    expect(output).toContain('childEnvironments: ["ssr"]');
    expect(output.match(/cloudflare\(/g)).toHaveLength(1);
    expect(
      updateViteConfigForCloudflare("vite.config.ts", output, {
        isAppRouter: true,
        nativeModulesToStub: [],
      }),
    ).toBe(output);
  });

  it("adds viteEnvironment to an existing configured cloudflare() call", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [vinext(), cloudflare({ configPath: "./wrangler.jsonc" })],
});
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: true,
      nativeModulesToStub: [],
    });

    expectValidConfig(output);
    expect(output).toContain('configPath: "./wrangler.jsonc"');
    expect(output).toContain('childEnvironments: ["ssr"]');
  });

  it("rejects dynamic cloudflare() options instead of leaving App Router misconfigured", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
const cloudflareOptions = {};
export default { plugins: [vinext(), cloudflare(cloudflareOptions)] };
`;

    expect(() =>
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: true,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "data-cache",
          imageOptimization: "none",
        },
      }),
    ).toThrow("cloudflare() plugin options must be a static object");
  });

  it("rejects an incomplete existing viteEnvironment", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
export default { plugins: [vinext(), cloudflare({ viteEnvironment: {} })] };
`;

    expect(() =>
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: true,
        nativeModulesToStub: [],
      }),
    ).toThrow('viteEnvironment option must statically set name: "rsc"');
  });

  it("preserves a complete existing viteEnvironment", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
export default { plugins: [vinext(), cloudflare({
  viteEnvironment: { name: "rsc", childEnvironments: ["ssr", "other"] },
})] };
`;

    expect(
      updateViteConfigForCloudflare("vite.config.ts", input, {
        isAppRouter: true,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "data-cache",
          imageOptimization: "none",
        },
      }),
    ).toBe(input);
  });

  it("leaves an existing cloudflare() call alone for the Pages Router", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [vinext(), cloudflare()],
});
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
    });

    expect(output).not.toContain("viteEnvironment");
  });

  it("updates a CommonJS Pages Router config", () => {
    const input = `const { defineConfig } = require("vite");
const vinext = require("vinext");

module.exports = defineConfig({ plugins: [vinext()] });
`;

    const output = updateViteConfigForCloudflare("vite.config.cjs", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
    });

    expect(output).toContain('const { cloudflare } = require("@cloudflare/vite-plugin");');
    expect(output).toContain("cloudflare()");
  });

  it("reuses a namespace vinext import through its default export", () => {
    const input = `import * as vx from "vinext";
export default { plugins: [vx.default()] };
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      prerender: true,
    });

    expectValidConfig(output);
    expect(output.match(/vx\.default\(/g)).toHaveLength(1);
    expect(output).toContain('prerender: { routes: "*" }');
    expect(output).not.toContain('import vinext from "vinext"');
    expect(
      updateViteConfigForCloudflare("vite.config.ts", output, {
        isAppRouter: false,
        nativeModulesToStub: [],
        prerender: true,
      }),
    ).toBe(output);
  });

  it("reuses a namespace vinext require through its default export", () => {
    const input = `const vx = require("vinext");
module.exports = { plugins: [vx.default()] };
`;

    const options = {
      isAppRouter: false,
      nativeModulesToStub: [],
      prerender: true,
    };
    const output = updateViteConfigForCloudflare("vite.config.cjs", input, options);

    expectValidConfig(output);
    expect(output.match(/vx\.default\(/g)).toHaveLength(1);
    expect(output).toContain('prerender: { routes: "*" }');
    expect(output).not.toContain("vx()");
    expect(updateViteConfigForCloudflare("vite.config.cjs", output, options)).toBe(output);
  });

  it.each([
    ["default import", 'import tw from "@tailwindcss/vite";', "tw()", 1],
    ["named default import", 'import { default as tw } from "@tailwindcss/vite";', "tw()", 1],
    ["namespace import", 'import * as tw from "@tailwindcss/vite";', "tw.default()", 1],
    [
      "namespace import with computed default access",
      'import * as tw from "@tailwindcss/vite";',
      'tw["default"]({ optimize: false })',
      1,
    ],
    ["nested plugin array", 'import tw from "@tailwindcss/vite";', "[tw({ optimize: false })]", 1],
    [
      "spread nested plugin array",
      'import tw from "@tailwindcss/vite";',
      "...[tw({ optimize: false })]",
      1,
    ],
    [
      "conditional plugin call",
      'import tw from "@tailwindcss/vite";',
      "enabled ? tw({ optimize: false }) : null",
      1,
    ],
    [
      "logical plugin call",
      'import tw from "@tailwindcss/vite";',
      "isProduction && tw({ optimize: false })",
      1,
    ],
    [
      "call wrapped with satisfies",
      'import tw from "@tailwindcss/vite";',
      "tw({ optimize: false }) satisfies PluginOption",
      1,
    ],
    [
      "call wrapped with as",
      'import tw from "@tailwindcss/vite";',
      "tw({ optimize: false }) as PluginOption",
      1,
    ],
    [
      "call wrapped with non-null assertion",
      'import tw from "@tailwindcss/vite";',
      "tw({ optimize: false })!",
      1,
    ],
    [
      "default import after a type-only import",
      `import type { PluginOptions } from "@tailwindcss/vite";
import tw from "@tailwindcss/vite";`,
      "tw()",
      2,
    ],
    [
      "namespace import after a type-only import",
      `import type { PluginOptions } from "@tailwindcss/vite";
import * as tw from "@tailwindcss/vite";`,
      "tw.default()",
      2,
    ],
  ])("reuses an existing Tailwind v4 %s", (_, tailwindImport, tailwindCall, importCount) => {
    const input = `${tailwindImport}
import vinext from "vinext";

export default { plugins: [vinext(), ${tailwindCall}] };
`;
    const options = {
      isAppRouter: false,
      hasTailwindV4: true,
      nativeModulesToStub: [],
    };
    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);

    expectValidConfig(output);
    expect(output.split("@tailwindcss/vite").length - 1).toBe(importCount);
    expect(output.split(tailwindCall)).toHaveLength(2);
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("does not treat a discarded logical-expression call as configured", () => {
    const input = `import tw from "@tailwindcss/vite";
export default { plugins: [tw() && react()] };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output.match(/tw\(\)/g)).toHaveLength(2);
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("recognizes an identifier-backed Tailwind plugin instance", () => {
    const input = `import tw from "@tailwindcss/vite";
const tailwindPlugin = tw({ optimize: false });
export default { plugins: [tailwindPlugin] };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toBe(input);
  });

  it("recognizes an immutable alias of the Tailwind factory", () => {
    const input = `import tailwind from "@tailwindcss/vite";
const tw = tailwind;
export default { plugins: [tw({ optimize: false })] };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toBe(input);
  });

  it("recognizes an unshadowed alias of a shadowed Tailwind import", () => {
    const input = `import { defineConfig } from "vite";
import tailwind from "@tailwindcss/vite";
const tw = tailwind;
export default defineConfig(() => {
  const tailwind = customPlugin;
  return { plugins: [tw({ optimize: false })] };
});
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toBe(input);
  });

  it("preserves an ESM hashbang when adding the Tailwind import", () => {
    const input = `#!/usr/bin/env node
export default { plugins: [] };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(output).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("loads Tailwind's ESM-only Vite plugin from a CommonJS config", async () => {
    const input = `const { defineConfig } = require("vite");
const vinext = require("vinext");

module.exports = defineConfig({ plugins: [vinext()] });
`;
    const options = {
      isAppRouter: false,
      hasTailwindV4: true,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none" as const,
        cdnCache: "none" as const,
        imageOptimization: "none" as const,
      },
    };
    const output = updateViteConfigForCloudflare("vite.config.cjs", input, options);
    expectValidConfig(output);
    expect(output).not.toContain('require("@tailwindcss/vite")');
    expect(output).toContain('import("@tailwindcss/vite")');
    expect(updateViteConfigForCloudflare("vite.config.cjs", output, options)).toBe(output);

    const configModule: { exports: { plugins?: unknown[] } } = { exports: {} };
    const tailwindEntry = createRequire(
      new URL("../examples/benchmarks/package.json", import.meta.url),
    ).resolve("@tailwindcss/vite");
    vm.runInNewContext(
      output.replace(
        'import("@tailwindcss/vite")',
        `import(${JSON.stringify(pathToFileURL(tailwindEntry).href)})`,
      ),
      {
        module: configModule,
        require(id: string): unknown {
          if (id === "vite") return { defineConfig: (config: unknown) => config };
          if (id === "vinext") return () => "vinext";
          if (id === "@cloudflare/vite-plugin") return { cloudflare: () => "cloudflare" };
          throw new Error(`Unexpected require: ${id}`);
        },
      },
      {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      },
    );

    const plugins = (await Promise.all(configModule.exports.plugins ?? [])).flat(Infinity);
    expect(plugins).toContain("vinext");
    expect(plugins).toContain("cloudflare");
    expect(plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.stringContaining("tailwindcss") }),
      ]),
    );
  });

  it.each([
    [
      "with an existing namespace require",
      'const tw = require("@tailwindcss/vite");\n',
      "tw.default()",
    ],
    [
      "with an existing unwrapped require",
      'const tw = require("@tailwindcss/vite").default;\n',
      "tw()",
    ],
    [
      "with computed default access",
      'const tw = require("@tailwindcss/vite")["default"];\n',
      "tw({ optimize: false })",
    ],
    [
      "with an existing destructured require",
      'const { default: tw } = require("@tailwindcss/vite");\n',
      "tw()",
    ],
  ])("loads Tailwind v4 from a CommonJS config %s", (_, tailwindRequire, tailwindCall) => {
    const input = `const { defineConfig } = require("vite");
const vinext = require("vinext");
${tailwindRequire}

module.exports = defineConfig({ plugins: [vinext()${tailwindRequire ? `, ${tailwindCall}` : ""}] });
`;
    const output = updateViteConfigForCloudflare("vite.config.cjs", input, {
      isAppRouter: false,
      hasTailwindV4: true,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "none", imageOptimization: "none" },
    });
    expect(output.split(tailwindCall).length - 1).toBe(1);

    const configModule: { exports: unknown } = { exports: {} };
    vm.runInNewContext(output, {
      module: configModule,
      require(id: string): unknown {
        if (id === "vite") return { defineConfig: (config: unknown) => config };
        if (id === "vinext") return () => "vinext";
        if (id === "@tailwindcss/vite") return { default: () => "tailwind" };
        if (id === "@cloudflare/vite-plugin") return { cloudflare: () => "cloudflare" };
        throw new Error(`Unexpected require: ${id}`);
      },
    });
    expect(configModule.exports).toMatchObject({ plugins: ["vinext", "tailwind", "cloudflare"] });
  });

  it.each([
    [
      "typed namespace require",
      'const tw = require("@tailwindcss/vite") as typeof import("@tailwindcss/vite");',
      "tw.default()",
    ],
    [
      "typed default require",
      'const tw = require("@tailwindcss/vite").default as typeof import("@tailwindcss/vite").default;',
      "tw()",
    ],
    [
      "typed require before default access",
      'const tw = (require("@tailwindcss/vite") as typeof import("@tailwindcss/vite")).default;',
      "tw()",
    ],
  ])("reuses a %s", (_, tailwindRequire, tailwindCall) => {
    const input = `const { defineConfig } = require("vite");
const vinext = require("vinext");
${tailwindRequire}

module.exports = defineConfig({ plugins: [vinext(), ${tailwindCall}] });
`;
    const options = {
      isAppRouter: false,
      hasTailwindV4: true,
      nativeModulesToStub: [],
    };
    const output = updateViteConfigForCloudflare("vite.config.cts", input, options);

    expectValidConfig(output);
    expect(output.split("@tailwindcss/vite").length - 1).toBe(2);
    expect(output.split(tailwindCall)).toHaveLength(2);
    expect(updateViteConfigForCloudflare("vite.config.cts", output, options)).toBe(output);
  });

  it("adds both plugins to an empty config with one plugins property", () => {
    const output = updateViteConfigForCloudflare("vite.config.ts", "export default {};\n", {
      isAppRouter: false,
      nativeModulesToStub: [],
    });

    expectValidConfig(output);
    expect(output.match(/\bplugins\s*:/g)).toHaveLength(1);
    expect(output).toContain("vinext()");
    expect(output).toContain("cloudflare()");
  });

  it("preserves populated plugin arrays while adding both missing plugins", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      'import custom from "./custom.js";\nexport default { plugins: [custom()] };\n',
      { isAppRouter: false, nativeModulesToStub: [] },
    );

    expectValidConfig(output);
    expect(output.match(/\bplugins\s*:/g)).toHaveLength(1);
    expect(output).toContain("custom()");
    expect(output).toContain("vinext()");
    expect(output).toContain("cloudflare()");
  });

  it("wraps inline plugin arrays while preserving comments", () => {
    const input = `import first from "./first.js";
import second from "./second.js";
export default { plugins: [first(), /* keep second */ second()] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "none",
      },
    });
    expectValidConfig(output);
    expect(output).toContain(
      "plugins: [\n  first(),\n  /* keep second */\n  second(),\n  vinext(),\n  cloudflare(),\n]",
    );
    expect(
      updateViteConfigForCloudflare("vite.config.ts", output, {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "data-cache",
          imageOptimization: "none",
        },
      }),
    ).toBe(output);
  });

  it("preserves comments in existing plugin arrays", () => {
    const input = `import custom from "./custom.js";
export default {
  plugins: [
    // Keep this plugin first.
    custom(),
  ],
};
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
    });

    expectValidConfig(output);
    expect(output).toContain("// Keep this plugin first.");
    expect(output).toContain("custom()");
    expect(output).toContain("vinext()");
    expect(output).toContain("cloudflare()");
  });

  it("handles long comment-like plugin array suffixes without regex backtracking", () => {
    const suffix = "*//*".repeat(10_000);
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import custom from "./custom.js";\nexport default { plugins: [custom(), /*${suffix}*/] };\n`,
      { isAppRouter: false, nativeModulesToStub: [] },
    );
    expectValidConfig(output);
    expect(output).toContain("vinext()");
    expect(output).toContain("cloudflare()");
  });

  it.each(['custom("/*")', "custom(`//`)"])(
    "ignores comment markers inside the final plugin expression: %s",
    (expression) => {
      const output = updateViteConfigForCloudflare(
        "vite.config.ts",
        `import custom from "./custom.js";\nexport default { plugins: [${expression},] };\n`,
        { isAppRouter: false, nativeModulesToStub: [] },
      );
      expectValidConfig(output);
      expect(output).not.toContain(`${expression},,`);
      expect(output).toContain("vinext()");
      expect(output).toContain("cloudflare()");
    },
  );

  it("allocates collision-free bindings for inserted imports", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      "const vinext = 1; const cloudflare = 2; const path = 3; export default {};\n",
      { isAppRouter: false, nativeModulesToStub: ["sharp"] },
    );

    expectValidConfig(output);
    expect(output).toContain('import vinext2 from "vinext"');
    expect(output).toContain('import { cloudflare as cloudflare2 } from "@cloudflare/vite-plugin"');
    expect(output).toContain('import path2 from "node:path"');
    expect(output).toContain("vinext2()");
    expect(output).toContain("cloudflare2()");
    expect(output).toContain('path2.resolve(__dirname, "empty-stub.js")');
  });

  it("uses the collision-free Response Store adapter binding", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      "const responseStoreAdapter = customFactory; export default { plugins: [] };\n",
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "response-store",
          imageOptimization: "none",
        },
      },
    );

    expectValidConfig(output);
    expect(output).toContain(
      'import { responseStoreAdapter as responseStoreAdapter2 } from "@vinext/cloudflare/cache/response-store-adapter"',
    );
    expect(output).toContain("cache: responseStoreAdapter2()");
  });

  it.each([
    ["enum cloudflare { Existing }", "cloudflare2"],
    ["namespace vinext { export const existing = true }", "vinext2"],
  ])("avoids TypeScript runtime binding collisions from %s", (declaration, binding) => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `${declaration}\nexport default {};\n`,
      { isAppRouter: false, nativeModulesToStub: [] },
    );

    expectValidConfig(output);
    expect(output).toContain(`${binding}()`);
  });

  it.each([
    ['import "vinext";', 'import vinext from "vinext";'],
    ['import { something } from "vinext";', 'import vinext from "vinext";'],
  ])("adds a separate default vinext import for %s", (existingImport, expectedImport) => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `${existingImport}\nexport default {};\n`,
      { isAppRouter: false, nativeModulesToStub: [] },
    );

    expectValidConfig(output);
    expect(output).toContain(existingImport);
    expect(output).toContain(expectedImport);
    expect(output).toContain("vinext()");
  });

  it.each([
    ['import "node:path";', 'import path from "node:path";'],
    ['import { resolve } from "node:path";', 'import path from "node:path";'],
  ])("adds a separate default path import for %s", (existingImport, expectedImport) => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `${existingImport}\nexport default {};\n`,
      { isAppRouter: false, nativeModulesToStub: ["sharp"] },
    );

    expectValidConfig(output);
    expect(output).toContain(existingImport);
    expect(output).toContain(expectedImport);
    expect(output).toContain('path.resolve(__dirname, "empty-stub.js")');
  });

  it("is idempotent", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext()] };
`;
    const once = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
    });
    const twice = updateViteConfigForCloudflare("vite.config.ts", once, {
      isAppRouter: false,
      nativeModulesToStub: [],
    });
    expectValidConfig(twice);
    expect(twice).toBe(once);
  });

  it("adds cache and image options to the same existing vinext call", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";\nexport default { plugins: [vinext()] };\n`,
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "kv",
          cdnCache: "workers-cache",
          imageOptimization: "cloudflare-images",
        },
      },
    );
    expectValidConfig(output);
    expect(output).toContain(
      "vinext({\n    cache: { data: kvDataAdapter(), cdn: cdnAdapter() },\n    images: { optimizer: imagesOptimizer() },\n  })",
    );
  });

  it("adds prerender to an existing vinext options object", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";
export default { plugins: [vinext({ cache: { data: customData() } })] };
`,
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: { dataCache: "kv", cdnCache: "data-cache", imageOptimization: "none" },
        prerender: true,
      },
    );
    expectValidConfig(output);
    expect(output).toContain("cache: { data: customData() }");
    expect(output).toContain('prerender: { routes: "*" }');
  });

  it("preserves an existing prerender option", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext({ prerender: true })] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "data-cache", imageOptimization: "none" },
      prerender: true,
    });
    expectValidConfig(output);
    expect(output.match(/prerender/g)).toHaveLength(1);
    expect(output).toContain("prerender: true");
  });

  it.each(["undefined", "null"])("replaces an unusable %s image optimizer", (value) => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";\nexport default { plugins: [vinext({ images: { optimizer: ${value} } })] };\n`,
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "workers-cache",
          imageOptimization: "cloudflare-images",
        },
      },
    );
    expectValidConfig(output);
    expect(output).toContain("optimizer: imagesOptimizer()");
  });

  it("updates an existing Cloudflare images optimizer to match a custom Wrangler binding", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";\nimport { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";\nexport default { plugins: [vinext({ images: { optimizer: imagesOptimizer() } })] };\n`,
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        imagesBinding: "CUSTOM_IMAGES",
        cache: {
          dataCache: "none",
          cdnCache: "workers-cache",
          imageOptimization: "cloudflare-images",
        },
      },
    );
    expectValidConfig(output);
    expect(output).toContain('optimizer: imagesOptimizer({ binding: "CUSTOM_IMAGES" })');
  });

  it("preserves an unrelated custom image optimizer", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";\nexport default { plugins: [vinext({ images: { optimizer: customOptimizer() } })] };\n`,
      {
        isAppRouter: false,
        nativeModulesToStub: [],
        imagesBinding: "CUSTOM_IMAGES",
        cache: {
          dataCache: "none",
          cdnCache: "workers-cache",
          imageOptimization: "cloudflare-images",
        },
      },
    );
    expect(output).toContain("optimizer: customOptimizer()");
    expect(output).not.toContain("imagesOptimizer");
  });

  it("adds native module aliases through AST object updates", () => {
    const output = updateViteConfigForCloudflare(
      "vite.config.ts",
      `import vinext from "vinext";
export default { plugins: [vinext()], resolve: { alias: { existing: "/tmp/existing" } } };
`,
      { isAppRouter: false, nativeModulesToStub: ["sharp"] },
    );

    expect(output).toContain('import path from "node:path"');
    expect(output).toContain('"sharp": path.resolve(__dirname, "empty-stub.js")');
    expect(output).toContain('existing: "/tmp/existing"');
  });

  it("updates a static variable-backed plugin array", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
export const plugins = [vinext({ cache: {} }), cloudflare()];
export default { plugins };
`;
    const options = {
      isAppRouter: true,
      hasTailwindV4: true,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none" as const,
        cdnCache: "workers-cache" as const,
        imageOptimization: "none" as const,
      },
    };

    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);

    expectValidConfig(output);
    expect(output).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(output).toContain("tailwindcss()");
    expect(output).toContain("cdn: cdnAdapter()");
    expect(output).toContain(
      'cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })',
    );
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("updates a callback-local static plugin array", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
export default defineConfig(() => {
  const plugins = [vinext()];
  return { plugins };
});
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(output).toContain("const plugins = [");
    expect(output).toContain("tailwindcss()");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("does not treat conditional required plugins as configured", () => {
    const input = `import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
const enabled = process.env.CLOUDFLARE === "true";
export default { plugins: [vinext(), enabled && cloudflare()] };
`;

    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: true,
      nativeModulesToStub: [],
    });

    expectValidConfig(output);
    expect(output).toContain("enabled && cloudflare()");
    expect(output).toMatch(
      /cloudflare\(\{\s+viteEnvironment: \{\s+name: "rsc",\s+childEnvironments: \["ssr"\],/,
    );
  });

  it("rejects a mutable variable-backed plugin array", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
let plugins = [];
plugins = [vinext()];
export default { plugins };
`,
      ),
    ).toThrow("plugins option must be an array");
  });

  it.each(["satisfies UserConfig", "as UserConfig"])(
    "updates a config wrapped with %s",
    (wrapper) => {
      const output = updateViteConfigForTailwind(
        "vite.config.ts",
        `import type { UserConfig } from "vite";
import vinext from "vinext";
export default ({ plugins: [vinext()] } ${wrapper});
`,
      );

      expectValidConfig(output);
      expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    },
  );

  it("unwraps a type-wrapped defineConfig call", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig, type UserConfig } from "vite";
import vinext from "vinext";
export default (defineConfig({ plugins: [vinext()] }) satisfies UserConfig);
`,
    );

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it.each(["const", "export const"])(
    "updates a config exported through an %s variable",
    (declaration) => {
      const output = updateViteConfigForTailwind(
        "vite.config.ts",
        `import { defineConfig } from "vite";
import vinext from "vinext";
${declaration} config = defineConfig({ plugins: [vinext()] });
export default config;
`,
      );

      expectValidConfig(output);
      expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    },
  );

  it("updates a callback config exported through a variable", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import vinext from "vinext";
const config = defineConfig(() => ({ plugins: [vinext()] }));
export default config;
`,
    );

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it.each(["satisfies UserConfigFn", "as UserConfigFn"])(
    "updates a defineConfig callback wrapped with %s",
    (wrapper) => {
      const output = updateViteConfigForTailwind(
        "vite.config.ts",
        `import { defineConfig, type UserConfigFn } from "vite";
export default defineConfig((() => ({ plugins: [] })) ${wrapper});
`,
      );

      expectValidConfig(output);
      expect(output).toContain("plugins: [\n  tailwindcss(),\n]");
      expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
    },
  );

  it("updates a callback-local returned config binding", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import vinext from "vinext";
export default defineConfig(() => {
  const config = { plugins: [vinext()] };
  return config;
});
`,
    );

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n    vinext(),\n    tailwindcss(),\n  ]");
  });

  it("rejects callback configs with nested return branches", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import { defineConfig } from "vite";
export default defineConfig(({ command }) => {
  if (command === "serve") return { plugins: [] };
  return { plugins: [] };
});
`,
      ),
    ).toThrow("Could not find a static Vite config object");
  });

  it("recognizes the defineConfig alias used by the exported variable", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig as first, defineConfig as second } from "vite";
import vinext from "vinext";
void first;
const config = second({ plugins: [vinext()] });
export default config;
`,
    );

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
  });

  it("rejects an unrecognized config factory", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
const second = (_first, value) => value;
const config = second({ plugins: [] }, { plugins: [vinext()] });
export default config;
`,
      ),
    ).toThrow("Could not find a static Vite config object");
  });

  it("loads an updated CommonJS config and plugin array exported through variables", async () => {
    const output = updateViteConfigForTailwind(
      "vite.config.cjs",
      `#!/usr/bin/env node
const vinext = require("vinext");
const plugins = [vinext()];
const config = { plugins };
module.exports = config;
`,
    );

    expectValidConfig(output);
    expect(output.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(output).toContain("tailwindcss()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);

    const configModule: { exports: { plugins?: unknown[] } } = { exports: {} };
    const tailwindEntry = createRequire(
      new URL("../examples/benchmarks/package.json", import.meta.url),
    ).resolve("@tailwindcss/vite");
    vm.runInNewContext(
      output.replace(
        'import("@tailwindcss/vite")',
        `import(${JSON.stringify(pathToFileURL(tailwindEntry).href)})`,
      ),
      {
        module: configModule,
        require(id: string): unknown {
          if (id === "vinext") return () => "vinext";
          throw new Error(`Unexpected require: ${id}`);
        },
      },
      {
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
      },
    );

    const plugins = (await Promise.all(configModule.exports.plugins ?? [])).flat(Infinity);
    expect(plugins).toContain("vinext");
    expect(plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.stringContaining("tailwindcss") }),
      ]),
    );
  });

  it("rejects multiple CommonJS export assignments", () => {
    const input = `const vinext = require("vinext");
module.exports = { plugins: [] };
module.exports = { plugins: [vinext()] };
`;

    expect(() => updateViteConfigForTailwind("vite.config.cjs", input)).toThrow(
      "Could not find a static Vite config object",
    );
  });

  it("rejects a mutable variable-backed config", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
let config = { plugins: [vinext()] };
config = getConfig();
export default config;
`,
      ),
    ).toThrow("Could not find a static Vite config object");
  });

  it("does not reuse a dynamic import helper that only returns the Tailwind factory", () => {
    const input = `const vinext = require("vinext");
const tailwindcss = () => import("@tailwindcss/vite").then((module) => module.default);
module.exports = { plugins: [vinext()] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expect(output).toContain(
      'const tailwindcss2 = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());',
    );
    expect(output).toContain("tailwindcss2()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);
  });

  it("does not invoke a parameterized dynamic import helper without arguments", () => {
    const input = `const vinext = require("vinext");
const loadTailwind = (options) => import("@tailwindcss/vite").then((module) => module.default(options.tailwind));
module.exports = { plugins: [vinext()] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expect(output).toContain(
      'const tailwindcss = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());',
    );
    expect(output).toContain("tailwindcss()");
    expect(output).not.toContain("loadTailwind()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);
  });

  it("does not reuse a dynamic import helper with a nested alternate return", () => {
    const input = `const vinext = require("vinext");
const loadTailwind = () => import("@tailwindcss/vite").then((module) => {
  if (process.env.CUSTOM_TAILWIND) return customPlugin();
  return module.default();
});
module.exports = { plugins: [vinext()] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expect(output).toContain(
      'const tailwindcss = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());',
    );
    expect(output).toContain("tailwindcss()");
    expect(output).not.toContain("loadTailwind()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);
  });

  it("recognizes an unshadowed alias of a shadowed dynamic import helper", () => {
    const input = `const { defineConfig } = require("vite");
const loadTailwind = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());
const tw = loadTailwind;
module.exports = defineConfig(() => {
  const loadTailwind = customPlugin;
  return { plugins: [tw()] };
});
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expectValidConfig(output);
    expect(output).toBe(input);
  });

  it("does not reuse an alias derived from a mutable dynamic import helper", () => {
    const input = `let loadTailwind = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());
loadTailwind = customPlugin;
const tw = loadTailwind;
module.exports = { plugins: [tw()] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expectValidConfig(output);
    expect(output).toContain(
      'const tailwindcss = () => import("@tailwindcss/vite").then(({ default: plugin }) => plugin());',
    );
    expect(output).toContain("tailwindcss()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);
  });

  it("avoids helpers shadowed by a nested program-scoped var declaration", () => {
    const input = `if (false) {
  var tailwindcss = customPlugin;
}
module.exports = { plugins: [] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expectValidConfig(output);
    expect(output).toContain("const tailwindcss2 =");
    expect(output).toContain("tailwindcss2()");
    expect(updateViteConfigForTailwind("vite.config.cjs", output)).toBe(output);
  });

  it("preserves a CommonJS directive prologue", () => {
    const input = `"use strict";
const vinext = require("vinext");
module.exports = { plugins: [vinext()] };
`;

    const output = updateViteConfigForTailwind("vite.config.cjs", input);

    expect(output.startsWith('"use strict";')).toBe(true);
    expect(output.indexOf("const tailwindcss")).toBeGreaterThan(output.indexOf('"use strict";'));
  });

  it("rejects a plugins property that a later spread may override", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
const base = { plugins: [vinext()] };
export default { plugins: [], ...base };
`,
      ),
    ).toThrow("later spread or computed property may override it");
  });

  it("allows a later computed property with a literal name", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import vinext from "vinext";
export default { plugins: [vinext()], ["resolve"]: {} };
`,
    );

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("preserves a trailing property comma followed by a comment", () => {
    const input = `export default {
  resolve: {}, // keep
};
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toContain("resolve: {}, // keep");
    expect(output).toContain("plugins: [");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("uses unshadowed plugin aliases inside callback configs", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
export default defineConfig(() => {
  const vinext = customPlugin;
  const tailwindcss = customPlugin;
  const cloudflare = customPlugin;
  const plugins = [vinext(), tailwindcss(), cloudflare()];
  return { plugins };
});
`;
    const options = {
      isAppRouter: true,
      hasTailwindV4: true,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none" as const,
        cdnCache: "none" as const,
        imageOptimization: "none" as const,
      },
    };

    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);

    expectValidConfig(output);
    expect(output).toContain('import vinext2 from "vinext"');
    expect(output).toContain('import tailwindcss2 from "@tailwindcss/vite"');
    expect(output).toContain("cloudflare as cloudflare2");
    expect(output).toContain("vinext2()");
    expect(output).toContain("tailwindcss2()");
    expect(output).toContain("cloudflare2({");
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("resolves plugin bindings in an external plugin array's scope", () => {
    const input = `import { defineConfig } from "vite";
import tw from "@tailwindcss/vite";
const plugins = [tw()];
export default defineConfig(() => {
  const tw = customPlugin;
  return { plugins };
});
`;

    expect(updateViteConfigForTailwind("vite.config.ts", input)).toBe(input);
  });

  it.each([
    "config.plugins = [vinext()];",
    'config["plugins"] = [vinext()];',
    "const alias = config; alias.plugins = [vinext()];",
  ])("rejects a variable-backed config property write: %s", (write) => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
const config = { plugins: [] };
${write}
export default config;
`,
      ),
    ).toThrow("properties are mutated");
  });

  it.each([
    "Object.assign(config, { plugins: [vinext()] });",
    'Object.defineProperty(config, "plugins", { value: [vinext()] });',
    "const alias = config; Object.assign(alias, { plugins: [vinext()] });",
    "const plugins = config.plugins; plugins.push(vinext());",
    "const { plugins } = config; plugins.push(vinext());",
    "const { plugins: list } = config; list.push(vinext());",
  ])("rejects a variable-backed config mutator call: %s", (mutation) => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import vinext from "vinext";
const config = { plugins: [] };
${mutation}
export default config;
`,
      ),
    ).toThrow("properties are mutated");
  });

  it("allows a shadowed Object.assign helper that does not mutate the config", () => {
    const input = `const Object = { assign() {} };
const config = { plugins: [] };
Object.assign(config, {});
export default config;
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toContain("tailwindcss()");
  });

  it.each(["plugins.length = 0;", "plugins.splice(0);", "const alias = plugins; alias.splice(0);"])(
    "rejects a variable-backed plugin array mutation: %s",
    (mutation) => {
      expect(() =>
        updateViteConfigForTailwind(
          "vite.config.ts",
          `import vinext from "vinext";
const plugins = [vinext()];
${mutation}
export default { plugins };
`,
        ),
      ).toThrow("array is mutated");
    },
  );

  it("preserves commas inside comments when expanding an inline plugin array", () => {
    const input = `const first = () => ({ name: "first" });
const second = () => ({ name: "second" });
export default { plugins: [first() /* keep, comma */, second()] };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toContain("first(),\n  /* keep, comma */\n  second(),");
    expect(output).toContain("tailwindcss(),");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("updates options through immutable vinext and Cloudflare aliases", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
const vx = vinext;
const cf = cloudflare;
export default defineConfig(() => {
  const vinext = customPlugin;
  const cloudflare = customPlugin;
  return { plugins: [vx(), cf()] };
});
`;
    const options = {
      isAppRouter: true,
      nativeModulesToStub: [],
      prerender: true,
      cache: {
        dataCache: "none" as const,
        cdnCache: "none" as const,
        imageOptimization: "none" as const,
      },
    };

    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);

    expectValidConfig(output);
    expect(output).toContain('prerender: { routes: "*" }');
    expect(output).toContain(
      'cf({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } })',
    );
    expect(output.match(/\bvx\(/g)).toHaveLength(1);
    expect(output.match(/\bcf\(/g)).toHaveLength(1);
    expect(output).not.toContain("vinext2");
    expect(output).not.toContain("cloudflare2");
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("avoids plugin imports shadowed by nested function-scoped var declarations", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(() => {
  if (false) {
    var tailwindcss = customPlugin;
  }
  return { plugins: [] };
});
`,
    );

    expectValidConfig(output);
    expect(output).toContain('import tailwindcss2 from "@tailwindcss/vite"');
    expect(output).toContain("plugins: [\n    tailwindcss2(),\n  ]");
  });

  it("updates a config exported through a named default specifier", () => {
    const input = `import vinext from "vinext";
const config = { plugins: [vinext()] };
export { config as default };
`;

    const output = updateViteConfigForTailwind("vite.config.ts", input);

    expectValidConfig(output);
    expect(output).toContain("plugins: [\n  vinext(),\n  tailwindcss(),\n]");
    expect(updateViteConfigForTailwind("vite.config.ts", output)).toBe(output);
  });

  it("does not reuse a plugin import shadowed by a named config callback", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(function tailwindcss() {
  return { plugins: [] };
});
`,
    );

    expectValidConfig(output);
    expect(output).toContain('import tailwindcss2 from "@tailwindcss/vite"');
    expect(output).toContain("plugins: [\n    tailwindcss2(),\n  ]");
  });

  it("does not reuse a plugin import shadowed by a callback-local enum", () => {
    const output = updateViteConfigForTailwind(
      "vite.config.ts",
      `import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig(() => {
  enum tailwindcss { custom }
  return { plugins: [] };
});
`,
    );

    expectValidConfig(output);
    expect(output).toContain('import tailwindcss2 from "@tailwindcss/vite"');
    expect(output).toContain("plugins: [\n    tailwindcss2(),\n  ]");
  });

  it("rejects a plugin array shadowed by a named config callback", () => {
    expect(() =>
      updateViteConfigForTailwind(
        "vite.config.ts",
        `import { defineConfig } from "vite";
import vinext from "vinext";
const plugins = [vinext()];
export default defineConfig(function plugins() {
  return { plugins };
});
`,
      ),
    ).toThrow("plugins option must be an array");
  });

  it("rejects dynamic plugin arrays", () => {
    expect(() =>
      updateViteConfigForCloudflare(
        "vite.config.ts",
        `const plugins = getPlugins(); export default { plugins };`,
        { isAppRouter: false, nativeModulesToStub: [] },
      ),
    ).toThrow("plugins option must be an array");
  });

  it("uses aliased cache adapter imports in a newly added vinext plugin", () => {
    const input = `import { kvDataAdapter as kv } from "@vinext/cloudflare/cache/kv-data-adapter";
import { cdnAdapter as cdn } from "@vinext/cloudflare/cache/cdn-adapter";
export default { plugins: [] };
`;
    const options = {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "kv" as const,
        cdnCache: "workers-cache" as const,
        imageOptimization: "none" as const,
      },
    };

    const output = updateViteConfigForCloudflare("vite.config.ts", input, options);

    expectValidConfig(output);
    expect(output).toContain("cache: { data: kv(), cdn: cdn() }");
    expect(output).not.toContain("data: kvDataAdapter()");
    expect(output).not.toContain("cdn: cdnAdapter()");
    expect(updateViteConfigForCloudflare("vite.config.ts", output, options)).toBe(output);
  });

  it("adds only missing cache slots to an existing vinext config", () => {
    const input = `import vinext from "vinext";
import { existingData } from "./cache.js";
export default { plugins: [vinext({ cache: { data: existingData() } })] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "kv", cdnCache: "workers-cache", imageOptimization: "cloudflare-images" },
    });
    expectValidConfig(output);
    expect(output).toContain("data: existingData()");
    expect(output).toContain("cdn: cdnAdapter()");
    expect(output).not.toContain("kvDataAdapter");
  });

  it("falls through to the data cache and omits image optimization", () => {
    const output = updateViteConfigForCloudflare("vite.config.ts", "export default {};\n", {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "data-cache", imageOptimization: "none" },
    });
    expectValidConfig(output);
    expect(output).not.toContain("data:");
    expect(output).not.toContain("cdn:");
    expect(output).not.toContain("imagesOptimizer");
    expect(output).not.toContain("images:");
  });

  it("configures image optimization independently of cache adapters", () => {
    const output = updateViteConfigForCloudflare("vite.config.ts", "export default {};\n", {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "cloudflare-images",
      },
    });
    expectValidConfig(output);
    expect(output).not.toContain("cache:");
    expect(output).toContain("images: { optimizer: imagesOptimizer() }");
  });

  it("omits a CDN adapter without replacing existing image config", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext({ imageOptimization: true })] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "data-cache", imageOptimization: "none" },
    });
    expectValidConfig(output);
    expect(output).not.toContain("cdn:");
    expect(output).toContain("imageOptimization: true");
    expect(output).not.toContain("imagesOptimizer");
  });

  it("additively updates Wrangler JSONC", () => {
    const input = `{
  // keep this comment
  "name": "existing",
  "kv_namespaces": [{ "binding": "OTHER", "id": "other" }]
}\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "kv",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain("// keep this comment");
    expect(output).toContain('"binding": "OTHER"');
    expect(output).toContain('"binding": "VINEXT_KV_CACHE"');
    expect(output).toContain('"images": { "binding": "IMAGES" }');
    expect(
      updateWranglerConfigForCloudflare(output, {
        dataCache: "kv",
        cdnCache: "workers-cache",
        imageOptimization: "cloudflare-images",
      }),
    ).toBe(output);
  });

  it("adds a Worker entry and assets to an existing Wrangler config", () => {
    const options = {
      dataCache: "none" as const,
      cdnCache: "data-cache" as const,
      imageOptimization: "none" as const,
    };
    const output = updateWranglerConfigForCloudflare(`{ "name": "existing" }\n`, options);
    expect(JSON.parse(output)).toEqual({
      name: "existing",
      main: "vinext/server/fetch-handler",
      assets: { directory: "dist/client", not_found_handling: "none", binding: "ASSETS" },
    });
    expect(updateWranglerConfigForCloudflare(output, options)).toBe(output);
  });

  it("preserves an existing Worker entry and assets", () => {
    const input = `{
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none", "binding": "ASSETS" }
}\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "none",
      cdnCache: "data-cache",
      imageOptimization: "none",
    });
    expect(output).toBe(input);
  });

  it("rejects an existing Cloudflare Pages config instead of adding an incompatible main", () => {
    const input = `{ "pages_build_output_dir": "./dist/client" }\n`;

    expect(() =>
      updateWranglerConfigForCloudflare(input, {
        dataCache: "none",
        cdnCache: "data-cache",
        imageOptimization: "none",
      }),
    ).toThrow('"pages_build_output_dir", which cannot be combined with the Worker "main"');
  });

  it("keeps additive Wrangler JSON updates valid strict JSON", () => {
    const output = updateWranglerConfigForCloudflare(`{ "name": "existing" }\n`, {
      dataCache: "kv",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
    expect(JSON.parse(output)).toMatchObject({
      name: "existing",
      cache: { enabled: true },
      images: { binding: "IMAGES" },
      kv_namespaces: [{ binding: "VINEXT_KV_CACHE" }],
      version_metadata: { binding: "CF_VERSION_METADATA" },
    });
  });

  it("updates a comment-only Wrangler JSONC root without a leading comma", () => {
    const input = `{
  // keep this comment
}\n`;
    const options = {
      dataCache: "none" as const,
      cdnCache: "data-cache" as const,
      imageOptimization: "cloudflare-images" as const,
    };
    const output = updateWranglerConfigForCloudflare(input, options);
    expect(output).toContain("// keep this comment");
    expect(JSON.parse(output.replace("  // keep this comment\n", ""))).toEqual({
      main: "vinext/server/fetch-handler",
      assets: { directory: "dist/client", not_found_handling: "none", binding: "ASSETS" },
      images: { binding: "IMAGES" },
    });
    expect(updateWranglerConfigForCloudflare(output, options)).toBe(output);
  });

  it("enables an existing disabled Workers Cache config", () => {
    const output = updateWranglerConfigForCloudflare(`{ "cache": { "enabled": false } }\n`, {
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "none",
    });
    expect(JSON.parse(output)).toEqual({
      main: "vinext/server/fetch-handler",
      assets: { directory: "dist/client", not_found_handling: "none", binding: "ASSETS" },
      cache: { enabled: true },
      version_metadata: { binding: "CF_VERSION_METADATA" },
    });
  });

  it("preserves a custom Wrangler version metadata binding for the CDN adapter", () => {
    const input = `{ "version_metadata": { "binding": "CUSTOM_VERSION" } }\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "none",
    });

    expect(getWranglerVersionMetadataBinding(output)).toBe("CUSTOM_VERSION");
    expect(
      generateAppRouterViteConfig(
        undefined,
        {
          dataCache: "none",
          cdnCache: "workers-cache",
          imageOptimization: "none",
        },
        "IMAGES",
        false,
        "CUSTOM_VERSION",
      ),
    ).toContain('cdnAdapter({ versionMetadataBinding: "CUSTOM_VERSION" })');
  });

  it("aligns an existing Cloudflare CDN adapter with a custom version metadata binding", () => {
    const input = `import { defineConfig } from "vite";
import vinext from "vinext";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";

export default defineConfig({
  plugins: [vinext({ cache: { cdn: cdnAdapter() } })],
});
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: {
        dataCache: "none",
        cdnCache: "workers-cache",
        imageOptimization: "none",
      },
      versionMetadataBinding: "CUSTOM_VERSION",
    });

    expectValidConfig(output);
    expect(output).toContain('cdn: cdnAdapter({ versionMetadataBinding: "CUSTOM_VERSION" })');
    expect(
      updateViteConfigForCloudflare("vite.config.ts", output, {
        isAppRouter: false,
        nativeModulesToStub: [],
        cache: {
          dataCache: "none",
          cdnCache: "workers-cache",
          imageOptimization: "none",
        },
        versionMetadataBinding: "CUSTOM_VERSION",
      }),
    ).toBe(output);
  });

  it("preserves a custom Wrangler Images binding for the Vite adapter", () => {
    const options = {
      dataCache: "kv" as const,
      cdnCache: "workers-cache" as const,
      imageOptimization: "cloudflare-images" as const,
    };
    const input = `{ "images": { "binding": "CUSTOM_IMAGES" } }\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('"images": { "binding": "CUSTOM_IMAGES" }');
    expect(output).toContain('"cache": { "enabled": true }');
    expect(getWranglerImagesBinding(output)).toBe("CUSTOM_IMAGES");
    const vite = generateAppRouterViteConfig(undefined, options, "CUSTOM_IMAGES");
    expect(vite).toContain('imagesOptimizer({ binding: "CUSTOM_IMAGES" })');
  });

  it("generates Cloudflare Vite config with prerender when opted in", () => {
    const options = {
      dataCache: "none" as const,
      cdnCache: "data-cache" as const,
      imageOptimization: "none" as const,
    };
    expect(generateAppRouterViteConfig(undefined, options, "IMAGES", true)).toContain(
      'prerender: { routes: "*" }',
    );
    expect(generatePagesRouterViteConfig(undefined, options, "IMAGES", true)).toContain(
      'prerender: { routes: "*" }',
    );
  });

  it("repairs an unusable Wrangler Images binding", () => {
    const output = updateWranglerConfigForCloudflare(`{ "images": null }\n`, {
      dataCache: "none",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('"images": { "binding": "IMAGES" }');
  });

  it("handles JSONC comments inside Wrangler property values", () => {
    const input = `{
  "images": { /* } ], */ "binding": "CUSTOM_IMAGES" },
  "kv_namespaces": [
    // }, ],
    { "binding": "OTHER", "id": "other" }
  ]
}\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "kv",
      cdnCache: "workers-cache",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('"binding": "CUSTOM_IMAGES"');
    expect(output).toContain('"binding": "VINEXT_KV_CACHE"');
  });

  it("keeps Pages Router adapter plumbing independent of the selected backend", () => {
    const output = readPagesRouterEntrySource();
    expect(output).not.toContain("IMAGES");
    expect(output).not.toContain("handleImageOptimization");
    expect(output).toContain("handleConfiguredImageOptimization");
    expect(output).toContain("runPagesRequest(request, deps)");
  });
});
