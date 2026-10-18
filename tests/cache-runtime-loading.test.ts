import fs from "node:fs";
import path from "node:path";
import { parseSync } from "vite";
import type { ESTree } from "vite";
import { describe, expect, it, vi } from "vite-plus/test";

describe("cache runtime loading", () => {
  it("uses cache leaf modules without importing the public cache facade", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../packages/vinext/src/shims/cache-runtime.ts"),
      "utf8",
    );
    const parsed = parseSync("cache-runtime.ts", source, {
      astType: "ts",
      lang: "ts",
      sourceType: "module",
    });
    const runtimeImports = parsed.program.body
      .filter(
        (statement): statement is ESTree.ImportDeclaration =>
          statement.type === "ImportDeclaration" && statement.importKind !== "type",
      )
      .map((statement) => statement.source.value);

    expect(runtimeImports).toContain("./cache-handler.js");
    expect(runtimeImports).toContain("./cache-request-state.js");
    expect(runtimeImports).not.toContain("./cache.js");
  });

  it("replays cached RSC payloads without importing server reference modules", () => {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "../packages/vinext/src/shims/cache-runtime.ts"),
      "utf8",
    );

    expect(source).toContain("{ preserveServerReferences: true }");
  });

  it("keeps the request that starts the shared RSC codec import alive until it settles", async () => {
    // The codec import is memoized for the isolate, and workerd drops a
    // canceled request's pending I/O. A fresh module instance has no memo yet.
    vi.resetModules();
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-runtime.js");
    const { setCacheHandler, MemoryCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    const { runWithExecutionContext } =
      await import("../packages/vinext/src/shims/request-context.js");
    setCacheHandler(new MemoryCacheHandler());
    const cached = registerCachedFunction(async () => "value", "test:codec-lifetime");
    const creator = { waitUntil: vi.fn() };
    const joiner = { waitUntil: vi.fn() };

    const first = runWithExecutionContext(creator, () => cached());
    const second = runWithExecutionContext(joiner, () => cached());

    await expect(Promise.all([first, second])).resolves.toEqual(["value", "value"]);
    expect(creator.waitUntil).toHaveBeenCalledOnce();
    expect(joiner.waitUntil).not.toHaveBeenCalled();
  });
});
