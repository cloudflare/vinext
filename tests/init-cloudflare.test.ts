import { describe, expect, it } from "vite-plus/test";
import { parseSync } from "vite";
import {
  generateAppRouterViteConfig,
  generatePagesRouterViteConfig,
  getWranglerImagesBinding,
  updateViteConfigForCloudflare,
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

describe("updateViteConfigForCloudflare", () => {
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
        cache: { dataCache: "none", cdnCache: "data-cache", imageOptimization: "none" },
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

  it("rejects dynamic plugin arrays", () => {
    expect(() =>
      updateViteConfigForCloudflare(
        "vite.config.ts",
        `const plugins = []; export default { plugins };`,
        { isAppRouter: false, nativeModulesToStub: [] },
      ),
    ).toThrow("plugins option must be an array");
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
    });
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
