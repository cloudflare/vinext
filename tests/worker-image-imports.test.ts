import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import { createWorkerImageImportsPlugin } from "../packages/vinext/src/plugins/worker-image-imports.js";

type UnknownHook = (...args: never[]) => unknown;

function hookHandler(hook: unknown): UnknownHook {
  if (typeof hook === "function") return hook as UnknownHook;
  if (hook && typeof hook === "object") {
    const handler = Reflect.get(hook, "handler");
    if (typeof handler === "function") return handler as UnknownHook;
  }
  throw new Error("Expected plugin hook");
}

describe("worker image imports", () => {
  it("resolves aliased dynamic image imports before adding metadata", async () => {
    const imagePath = path.resolve(import.meta.dirname, "fixtures/app-basic/app/icon.png");
    const plugin = createWorkerImageImportsPlugin();
    const resolve = vi.fn().mockResolvedValue({ id: imagePath });
    const transform = hookHandler(plugin.transform) as unknown as (
      this: { resolve: typeof resolve },
      code: string,
      id: string,
    ) => Promise<{ code: string } | null>;

    const result = await transform.call(
      { resolve },
      'export const load = () => import("@images/test.png");',
      path.resolve(import.meta.dirname, "fixture/image.worker.ts"),
    );

    expect(resolve).toHaveBeenCalledWith("@images/test.png", expect.any(String), {
      skipSelf: true,
    });
    expect(result?.code).toContain('import("@images/test.png")');
    expect(result?.code).toContain("vinext-worker-image-meta:");
    expect(result?.code).toContain(imagePath);
  });

  it("versions only emitted static and dynamic worker chunk edges", () => {
    const plugin = createWorkerImageImportsPlugin({ deploymentId: "worker-dpl" });
    const renderChunk = hookHandler(plugin.renderChunk) as unknown as (
      this: object,
      code: string,
      chunk: { dynamicImports: string[]; fileName: string; imports: string[] },
    ) => { code: string } | null;
    const result = renderChunk.call(
      {},
      [
        'import value from "./static.js";',
        'export { value as renamed } from "./exported.js";',
        'export * from "./star.js";',
        'export const lazy = () => import("./dynamic.js");',
        'export const untouched = () => import("./user-runtime.js");',
      ].join("\n"),
      {
        fileName: "_next/static/workers/entry.js",
        imports: [
          "_next/static/workers/static.js",
          "_next/static/workers/exported.js",
          "_next/static/workers/star.js",
        ],
        dynamicImports: ["_next/static/workers/dynamic.js"],
      },
    );

    expect(result?.code).toContain('from "./static.js?dpl=worker-dpl"');
    expect(result?.code).toContain('from "./exported.js?dpl=worker-dpl"');
    expect(result?.code).toContain('from "./star.js?dpl=worker-dpl"');
    expect(result?.code).toContain('import("./dynamic.js?dpl=worker-dpl")');
    expect(result?.code).toContain('import("./user-runtime.js")');
  });
});
