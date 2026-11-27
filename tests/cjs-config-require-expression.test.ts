import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadNextConfig } from "../packages/vinext/src/config/next-config.js";
import {
  loadCommonJsModule,
  shouldRetryAsCommonJs,
} from "../packages/vinext/src/utils/commonjs-loader.js";

const fixtureRoot = path.join(import.meta.dirname, "fixtures", "cjs-config-require-expression");

// Vitest's module runner intercepts `import()`, so load through Node's own
// `require()` of an ES module, which raises the same native error.
function nativeLoadError(filePath: string): unknown {
  try {
    createRequire(import.meta.url)(filePath);
  } catch (error) {
    return error;
  }
  throw new Error(`${filePath} loaded without an error`);
}

describe("CommonJS config with require() inside an expression in a type:module package", () => {
  // Ported from Next.js: test/e2e/app-dir/next-config/next.config.js
  // (`console.log(require('webpack').sources.RawSource)`).
  it("loads next.config.js when require() is a call argument", async () => {
    const config = await loadNextConfig(fixtureRoot);
    expect(config?.env).toEqual({ CJS_REQUIRE_EXPRESSION: "loaded" });
  });

  it("retries postcss.config.js when require() is inside a multi-line plugins array", () => {
    const configPath = path.join(fixtureRoot, "postcss.config.js");
    const error = nativeLoadError(configPath);
    expect(error).toBeInstanceOf(ReferenceError);
    expect(shouldRetryAsCommonJs(error, configPath)).toBe(true);
    expect(loadCommonJsModule(configPath)).toEqual({ plugins: ["postcss/plugin"] });
  });

  it("does not retry when the global only appears as a property name", () => {
    const filePath = path.join(fixtureRoot, "property-names.js");
    const error = nativeLoadError(filePath);
    expect((error as Error).message).toBe("require is not defined in ES module scope");
    expect(shouldRetryAsCommonJs(error, filePath)).toBe(false);
  });
});
