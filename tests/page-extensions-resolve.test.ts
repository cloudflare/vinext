import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";
import { buildViteResolveExtensions } from "../packages/vinext/src/routing/file-matcher.js";

// Ported in spirit from Next.js: test/e2e/app-dir/resolve-extensions/
// https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/resolve-extensions/
//
// When users configure custom extensions via `pageExtensions` or
// `turbopack.resolveExtensions` (e.g. `.platform.tsx` or `.mdx`), Vite must
// know to attempt those extensions when resolving extensionless imports.
// Otherwise extensionless imports of files with those custom extensions
// fail to resolve and the build crashes.
//
// Regression test for cloudflare/vinext#1502.
describe("buildViteResolveExtensions", () => {
  it("applies Next.js default pageExtensions priority when pageExtensions is undefined", () => {
    // Even without a user-set pageExtensions, vinext normalises to the
    // Next.js defaults `["tsx", "ts", "jsx", "js"]` and uses that order.
    const extensions = buildViteResolveExtensions(undefined);
    expect(extensions).toEqual([".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts", ".json"]);
  });

  it("returns the same list when pageExtensions matches the Next.js defaults", () => {
    const extensions = buildViteResolveExtensions(["tsx", "ts", "jsx", "js"]);
    expect(extensions).toEqual([".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts", ".json"]);
  });

  it("prepends configured pageExtensions so user priority wins", () => {
    // Next.js resolve-extensions fixture places `.web.tsx` before `.tsx`.
    // The user's order must be preserved so `Component` resolves to
    // `Component.web.tsx` before `Component.tsx`.
    const extensions = buildViteResolveExtensions(["web.tsx", "tsx", "ts", "jsx", "js"]);
    expect(extensions[0]).toBe(".web.tsx");
    expect(extensions.indexOf(".web.tsx")).toBeLessThan(extensions.indexOf(".tsx"));
  });

  it("includes custom multi-segment extensions like .platform.tsx", () => {
    // This is what made cloudflare/vinext#1502 surface: a user-configured
    // multi-segment extension that Vite's defaults can't resolve.
    const extensions = buildViteResolveExtensions(["platform.tsx", "tsx", "ts", "jsx", "js"]);
    expect(extensions).toContain(".platform.tsx");
    expect(extensions[0]).toBe(".platform.tsx");
  });

  it("includes .mdx when configured", () => {
    const extensions = buildViteResolveExtensions(["tsx", "ts", "jsx", "js", "mdx"]);
    expect(extensions).toContain(".mdx");
  });

  it("dedupes overlapping entries", () => {
    const extensions = buildViteResolveExtensions(["tsx", "js"]);
    expect(extensions.filter((e) => e === ".tsx").length).toBe(1);
    expect(extensions.filter((e) => e === ".js").length).toBe(1);
  });

  it("strips leading dots and whitespace before normalising", () => {
    const extensions = buildViteResolveExtensions([".platform.tsx", " tsx ", ""]);
    expect(extensions[0]).toBe(".platform.tsx");
    expect(extensions).toContain(".tsx");
  });
});

describe("vinext plugin wires pageExtensions into Vite resolve.extensions", () => {
  it("forwards configured pageExtensions to config.resolve.extensions", async () => {
    // Ported in spirit from Next.js: test/e2e/app-dir/resolve-extensions/
    // The deploy suite failure surfaced when pageExtensions/resolveExtensions
    // were configured beyond Vite's defaults — Vite couldn't resolve
    // extensionless imports of files like `Component.platform.tsx`.
    // Regression test for cloudflare/vinext#1502.
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const mainPlugin = plugins.find(
      // oxlint-disable-next-line typescript/no-explicit-any
      (p: any) => p.name === "vinext:config" && typeof p.config === "function",
    );
    expect(mainPlugin).toBeDefined();

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-ext-resolve-"));
    const rootNodeModules = path.resolve(import.meta.dirname, "../node_modules");
    await fs.symlink(rootNodeModules, path.join(tmpDir, "node_modules"), "junction");

    await fs.mkdir(path.join(tmpDir, "pages"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "pages", "index.tsx"),
      `export default function Home() { return <h1>Home</h1>; }`,
    );
    await fs.writeFile(
      path.join(tmpDir, "next.config.mjs"),
      `export default { pageExtensions: ["platform.tsx", "tsx", "ts", "jsx", "js", "mdx"] };`,
    );

    try {
      const mockConfig = {
        root: tmpDir,
        build: {},
        plugins: [],
      };
      // oxlint-disable-next-line typescript/no-explicit-any
      const result = await (mainPlugin as any).config(mockConfig, { command: "build" });
      const extensions: string[] = result.resolve?.extensions ?? [];
      expect(extensions).toContain(".platform.tsx");
      expect(extensions).toContain(".mdx");
      expect(extensions).toContain(".tsx");
      // User priority must win — `.platform.tsx` resolves before `.tsx`
      // so a bare `./Component` import lands on `Component.platform.tsx`
      // (mirrors Next.js / Turbopack resolveExtensions semantics).
      expect(extensions.indexOf(".platform.tsx")).toBeLessThan(extensions.indexOf(".tsx"));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 15000);
});
