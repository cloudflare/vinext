import { describe, expect, it } from "vite-plus/test";
import { createExtensionlessDynamicImportPlugin } from "../packages/vinext/src/plugins/extensionless-dynamic-import.js";

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

describe("vinext:extensionless-dynamic-import", () => {
  it("expands extensionless relative template imports through import.meta.glob", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    const transform = unwrapHook(plugin.transform);
    const result = transform.call(
      plugin,
      "const moduleExports = await import(`./${slug}`)",
      "/app/page.tsx",
    );

    expect(result.code).toContain(
      'import.meta.glob("./**/*{.js,.jsx,.ts,.tsx,.mjs,.cjs,.mts,.cts}")',
    );
    expect(result.code).toContain("__vinextModules[__vinextPath + __vinextExtension]");
    expect(result.code).toContain("Promise.reject(new Error");
  });

  it("leaves imports with explicit extensions unchanged", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    const transform = unwrapHook(plugin.transform);
    const result = transform.call(plugin, "await import(`./${slug}.tsx`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("leaves bare package imports unchanged", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    const transform = unwrapHook(plugin.transform);
    const result = transform.call(plugin, "await import(`${packageName}`)", "/app/page.tsx");

    expect(result).toBeNull();
  });

  it("leaves imports with attributes unchanged", () => {
    const plugin = createExtensionlessDynamicImportPlugin();
    const transform = unwrapHook(plugin.transform);
    const result = transform.call(
      plugin,
      'await import(`./${slug}`, { with: { type: "json" } })',
      "/app/page.tsx",
    );

    expect(result).toBeNull();
  });
});
