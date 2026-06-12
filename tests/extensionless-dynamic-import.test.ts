import { describe, expect, it } from "vite-plus/test";
import { createExtensionlessDynamicImportPlugin } from "../packages/vinext/src/plugins/extensionless-dynamic-import.js";

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function createTransform(extensions?: string[]): Function {
  const plugin = createExtensionlessDynamicImportPlugin();
  if (extensions) {
    unwrapHook(plugin.configResolved).call(plugin, { resolve: { extensions } });
  }
  return unwrapHook(plugin.transform).bind(plugin);
}

describe("vinext:extensionless-dynamic-import", () => {
  it("expands extensionless relative template imports through import.meta.glob", () => {
    const transform = createTransform();
    const result = transform("const moduleExports = await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain("__vinextModules[__vinextPath + __vinextExtension]");
    expect(result.code).toContain('__vinextPath + "/index" + __vinextExtension');
    expect(result.code).toContain("Promise.reject(new Error");
  });

  it("uses configured resolver extensions in priority order", () => {
    const transform = createTransform([".platform.tsx", ".tsx", ".js", ".json"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain('[".platform.tsx",".tsx",".js",".json"]');
  });

  it("uses configured single resolver extensions at runtime", () => {
    const transform = createTransform([".js"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain('import.meta.glob("./**/*")');
    expect(result.code).toContain('[".js"]');
  });

  it("tries every file extension before directory index files", () => {
    const transform = createTransform([".tsx", ".js"]);
    const result = transform("await import(`./${slug}`)", "/app/page.tsx");

    expect(result.code.indexOf("__vinextPath + __vinextExtension")).toBeLessThan(
      result.code.indexOf('__vinextPath + "/index" + __vinextExtension'),
    );
    expect(result.code).not.toContain(
      '__vinextModules[__vinextPath + __vinextExtension] ?? __vinextModules[__vinextPath + "/index"',
    );
  });

  it("transforms imports separated from the call parenthesis by newlines", () => {
    const transform = createTransform();
    const result = transform("await import\n(`./${slug}`)", "/app/page.tsx");

    expect(result.code).toContain("import.meta.glob");
  });

  it("transforms imports with a static filename prefix", () => {
    const transform = createTransform();
    const result = transform("await import(`./components/prefixed-${slug}`)", "/app/page.tsx");

    expect(result.code).toContain(
      'import.meta.glob(["./components/prefixed-*","./components/prefixed-*/**/*"])',
    );
  });

  it("transforms imports with Webpack magic comments", () => {
    const transform = createTransform();
    const result = transform(
      'await import(/* webpackChunkName: "named" */ `./${slug}`)',
      "/app/page.tsx",
    );

    expect(result.code).toContain("import.meta.glob");
  });

  it("handles repeated block-comment markers without backtracking", () => {
    const transform = createTransform();
    const comments = "/*" + "*//*".repeat(10_000) + "*/";
    const result = transform(`await import(${comments} \`./\${slug}\`)`, "/app/page.tsx");

    expect(result.code).toContain("import.meta.glob");
  });

  it("leaves imports with explicit extensions unchanged", () => {
    const transform = createTransform();
    const result = transform("await import(`./${slug}.tsx`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("leaves bare package imports unchanged", () => {
    const transform = createTransform();
    const result = transform("await import(`${packageName}`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("leaves dependency imports unchanged", () => {
    const transform = createTransform();
    const result = transform(
      "await import(`./${locale}`)",
      "/app/node_modules/example-package/index.js",
    );

    expect(result).toBeNull();
  });

  it("leaves imports with attributes unchanged", () => {
    const transform = createTransform();
    const result = transform(
      'await import(`./${slug}`, { with: { type: "json" } })',
      "/app/page.tsx",
    );

    expect(result).toBeNull();
  });

  it.each([
    "await import(`./${slug}?raw`)",
    "await import(`./${slug}#section`)",
    "await import(`./[locale]/${slug}`)",
    "await import(`./${first}*/${second}`)",
    "await import(`./${first}.bak/${second}`)",
    "await import(`./${first}?query/${second}`)",
    "await import(`./file.${extension}`)",
  ])("leaves semantic import modifiers unchanged: %s", (code) => {
    const transform = createTransform();
    expect(transform(code, "/app/page.tsx")).toBeNull();
  });
});
