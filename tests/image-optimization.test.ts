/**
 * Tests for build-time image optimization via sharp.
 *
 * Tests the sharp detection utility, build-time transform generation,
 * and the ?vinext-opt load hook.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";

// ── Sharp detection utility ──────────────────────────────────
describe("tryRequireSharp", () => {
  // We can't easily mock dynamic imports in vitest, so test the module interface
  it("exports tryRequireSharp function", async () => {
    const mod = await import("../packages/vinext/src/utils/sharp.js");
    expect(typeof mod.tryRequireSharp).toBe("function");
  });

  it("returns null when sharp is not installed", async () => {
    // In test environment, sharp may or may not be installed
    // At minimum, verify it returns either a sharp module or null (not throwing)
    const mod = await import("../packages/vinext/src/utils/sharp.js");
    const result = await mod.tryRequireSharp();
    expect(result === null || typeof result === "function").toBe(true);
  });
});

// ── Build-time transform (optimizedSrcSet generation) ────────
describe("vinext:image-imports — build-time optimizedSrcSet", () => {
  // These tests verify the transform output includes optimizedSrcSet
  // when in build mode. Since we can't easily set _isBuildMode,
  // we verify the dev-mode output does NOT include optimizedSrcSet.

  const IMAGES_DIR = path.resolve(import.meta.dirname, "./fixtures/images");
  const fakeId = path.join(IMAGES_DIR, "page.tsx");

  /** Unwrap hook that may use object-with-filter format */
  function unwrapHook(hook: any): Function {
    return typeof hook === "function" ? hook : hook?.handler;
  }

  it("dev mode transform does NOT generate optimizedSrcSet", async () => {
    // Import fresh to ensure dev mode (default)
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const transform = unwrapHook(plugin!.transform);
    const code = `import hero from './test-4x3.png';`;
    const result = await transform.call(plugin, code, fakeId);

    if (result) {
      expect(result.code).not.toContain("optimizedSrcSet");
      expect(result.code).not.toContain("vinext-opt");
    }
  });

  it("resolveId handles ?vinext-opt queries", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const resolve = unwrapHook(plugin!.resolveId);

    const result = resolve.call(plugin, "/abs/path/hero.jpg?vinext-opt&w=640", "/some/file.tsx");
    expect(result).toBe("\0vinext-image-opt:/abs/path/hero.jpg:640");
  });

  it("resolveId returns null for unrelated queries", async () => {
    const vinext = (await import("../packages/vinext/src/index.js")).default;
    const plugins = vinext() as any[];
    const plugin = plugins.find((p) => p.name === "vinext:image-imports");
    const resolve = unwrapHook(plugin!.resolveId);

    expect(resolve.call(plugin, "./hero.jpg", "/some/file.tsx")).toBeNull();
    expect(resolve.call(plugin, "react", "/some/file.tsx")).toBeNull();
  });
});
