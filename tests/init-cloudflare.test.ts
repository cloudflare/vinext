import { describe, expect, it } from "vite-plus/test";
import { parseSync } from "vite";
import {
  generateAppRouterWorkerEntry,
  generatePagesRouterWorkerEntry,
  getWranglerImagesBinding,
  updateViteConfigForCloudflare,
  updateWranglerConfigForCloudflare,
  updateWranglerTomlForCloudflare,
} from "../packages/vinext/src/init-cloudflare.js";

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
    expect(twice).toBe(once);
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
      cache: { dataCache: "kv", cdnCache: "workers", imageOptimization: "cloudflare-images" },
    });
    expectValidConfig(output);
    expect(output).toContain("data: existingData()");
    expect(output).toContain("cdn: cdnAdapter()");
    expect(output).not.toContain("kvDataAdapter");
  });

  it("configures KV CDN and disables image optimization", () => {
    const output = updateViteConfigForCloudflare("vite.config.ts", "export default {};\n", {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "kv", imageOptimization: "none" },
    });
    expectValidConfig(output);
    expect(output).toContain("cdn: kvCdnAdapter()");
    expect(output).toContain("imageOptimization: false");
    expect(output).not.toContain("kvDataAdapter");
  });

  it("configures an explicit no-op CDN adapter and overrides image optimization", () => {
    const input = `import vinext from "vinext";
export default { plugins: [vinext({ imageOptimization: true })] };
`;
    const output = updateViteConfigForCloudflare("vite.config.ts", input, {
      isAppRouter: false,
      nativeModulesToStub: [],
      cache: { dataCache: "none", cdnCache: "none", imageOptimization: "none" },
    });
    expectValidConfig(output);
    expect(output).toContain(
      'import { noCdnCacheAdapter } from "@vinext/cloudflare/cache/no-cdn-adapter"',
    );
    expect(output).toContain("cdn: noCdnCacheAdapter()");
    expect(output).toContain("imageOptimization: false");
    expect(output).not.toContain("imageOptimization: true");
  });

  it("additively updates Wrangler JSONC", () => {
    const input = `{
  // keep this comment
  "name": "existing",
  "kv_namespaces": [{ "binding": "OTHER", "id": "other" }]
}\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "kv",
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain("// keep this comment");
    expect(output).toContain('"binding": "OTHER"');
    expect(output).toContain('"binding": "VINEXT_KV_CACHE"');
    expect(output).toContain('"images": { "binding": "IMAGES" }');
    expect(
      updateWranglerConfigForCloudflare(output, {
        dataCache: "kv",
        cdnCache: "workers",
        imageOptimization: "cloudflare-images",
      }),
    ).toBe(output);
  });

  it("preserves a custom Wrangler Images binding for generated workers", () => {
    const input = `{ "images": { "binding": "CUSTOM_IMAGES" } }\n`;
    const output = updateWranglerConfigForCloudflare(input, {
      dataCache: "none",
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toBe(input);
    expect(getWranglerImagesBinding(output, "json")).toBe("CUSTOM_IMAGES");
    expect(generateAppRouterWorkerEntry("cloudflare-images", "CUSTOM_IMAGES")).toContain(
      "env.CUSTOM_IMAGES.input(body)",
    );
  });

  it("repairs an unusable Wrangler Images binding", () => {
    const output = updateWranglerConfigForCloudflare(`{ "images": null }\n`, {
      dataCache: "none",
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('"images": { "binding": "IMAGES" }');
  });

  it("additively updates Wrangler TOML", () => {
    const input = `name = "existing"\n\n[vars]\nKEEP = "yes"\n`;
    const output = updateWranglerTomlForCloudflare(input, {
      dataCache: "kv",
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('[vars]\nKEEP = "yes"');
    expect(output).toContain('images = { binding = "IMAGES" }');
    expect(output).toContain('[[kv_namespaces]]\nbinding = "VINEXT_KV_CACHE"');
    expect(
      updateWranglerTomlForCloudflare(output, {
        dataCache: "kv",
        cdnCache: "workers",
        imageOptimization: "cloudflare-images",
      }),
    ).toBe(output);
  });

  it("does not confuse unrelated TOML bindings with KV namespaces", () => {
    const output = updateWranglerTomlForCloudflare(`[vars]\nbinding = "VINEXT_KV_CACHE"\n`, {
      dataCache: "kv",
      cdnCache: "workers",
      imageOptimization: "none",
    });
    expect(output).toContain('[[kv_namespaces]]\nbinding = "VINEXT_KV_CACHE"');
  });

  it("recognizes an existing TOML KV namespace binding", () => {
    const input = `[[kv_namespaces]]\nbinding = "VINEXT_KV_CACHE"\nid = "existing"\n`;
    expect(
      updateWranglerTomlForCloudflare(input, {
        dataCache: "kv",
        cdnCache: "workers",
        imageOptimization: "none",
      }),
    ).toBe(input);
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
      cdnCache: "workers",
      imageOptimization: "cloudflare-images",
    });
    expect(output).toContain('"binding": "CUSTOM_IMAGES"');
    expect(output).toContain('"binding": "VINEXT_KV_CACHE"');
  });

  it("reads a custom Images binding from Wrangler TOML", () => {
    expect(getWranglerImagesBinding('images = { binding = "CUSTOM_IMAGES" }\n', "toml")).toBe(
      "CUSTOM_IMAGES",
    );
  });

  it("preserves an Images TOML table and reads its binding", () => {
    const input = `[images]\nbinding = "CUSTOM_IMAGES"\n`;
    expect(
      updateWranglerTomlForCloudflare(input, {
        dataCache: "none",
        cdnCache: "workers",
        imageOptimization: "cloudflare-images",
      }),
    ).toBe(input);
    expect(getWranglerImagesBinding(input, "toml")).toBe("CUSTOM_IMAGES");
  });

  it("preserves a dotted Images TOML binding", () => {
    const input = `images.binding = "CUSTOM_IMAGES"\n`;
    expect(
      updateWranglerTomlForCloudflare(input, {
        dataCache: "none",
        cdnCache: "workers",
        imageOptimization: "cloudflare-images",
      }),
    ).toBe(input);
    expect(getWranglerImagesBinding(input, "toml")).toBe("CUSTOM_IMAGES");
  });

  it("preserves inline TOML KV namespace arrays", () => {
    const input = `kv_namespaces = [
  { binding = "VINEXT_KV_CACHE", id = "existing" }
]\n`;
    expect(
      updateWranglerTomlForCloudflare(input, {
        dataCache: "kv",
        cdnCache: "workers",
        imageOptimization: "none",
      }),
    ).toBe(input);
  });

  it("generates a direct App Router worker when images are disabled", () => {
    const output = generateAppRouterWorkerEntry("none");
    expect(output).toContain('import handler from "vinext/server/app-router-entry"');
    expect(output).not.toContain("IMAGES");
    expect(output).not.toContain("image-optimization");
  });

  it("removes the Pages Router image optimization path when disabled", () => {
    const output = generatePagesRouterWorkerEntry("none");
    expect(output).not.toContain("IMAGES");
    expect(output).not.toContain("handleImageOptimization");
    expect(output).not.toContain("isImageOptimizationPath");
    expect(output).toContain("runPagesRequest(request, deps)");
  });
});
