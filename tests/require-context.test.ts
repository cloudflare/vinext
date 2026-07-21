import { describe, expect, it } from "vite-plus/test";
import { createRequireContextPlugin } from "../packages/vinext/src/plugins/require-context.js";

function unwrapHook(hook: any): Function {
  return typeof hook === "function" ? hook : hook?.handler;
}

function createTransform(): Function {
  const plugin = createRequireContextPlugin();
  return unwrapHook(plugin.transform).bind(plugin);
}

describe("vinext:require-context", () => {
  it("rewrites literal require.context calls into an import.meta.glob map", () => {
    const transform = createTransform();
    const result = transform(
      `const ctx = require.context("./posts", true, /\\.md$/);`,
      "/app/page.tsx",
    );

    expect(result.code).toContain('import.meta.glob("./posts/**/*", { eager: true })');
  });

  it("reuses the cached transform result for a repeated id/source pair", () => {
    const transform = createTransform();
    const source = `const ctx = require.context("./posts", true, /\\.md$/);`;

    const first = transform(source, "/app/page.tsx");
    expect(first).toBeTruthy();
    expect(transform(source, "/app/page.tsx")).toBe(first);
    expect(transform(`${source}\nconsole.log("changed");`, "/app/page.tsx")).not.toBe(first);
    expect(transform(source, "/app/other.tsx")).not.toBe(first);
  });
});
