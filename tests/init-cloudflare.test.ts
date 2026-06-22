import { describe, expect, it } from "vite-plus/test";
import { parseSync } from "vite";
import { updateViteConfigForCloudflare } from "../packages/vinext/src/init-cloudflare.js";

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
});
