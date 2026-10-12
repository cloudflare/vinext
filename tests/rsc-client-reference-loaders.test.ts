import type { Plugin } from "vite";
import { describe, expect, it } from "vite-plus/test";
import {
  createDynamicPreloadChunksReferencePlugin,
  selectDynamicPreloadChunksReferenceKey,
} from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

describe("selectDynamicPreloadChunksReferenceKey", () => {
  const shimId = "/repo/node_modules/vinext/dist/shims/dynamic-preload-chunks.js";

  it("picks vinext's shim by module id, not a user module at a matching path", () => {
    const key = selectDynamicPreloadChunksReferenceKey(
      [
        ["/repo/app/shims/dynamic-preload-chunks.tsx", { referenceKey: "user" }],
        [shimId, { referenceKey: "helper" }],
      ],
      shimId,
    );

    expect(key).toBe("helper");
  });

  it("emits no key when the build has no vinext shim", () => {
    const key = selectDynamicPreloadChunksReferenceKey(
      [["/repo/app/shims/dynamic-preload-chunks.tsx", { referenceKey: "user" }]],
      shimId,
    );

    expect(key).toBeUndefined();
  });
});

describe("createDynamicPreloadChunksReferencePlugin", () => {
  const shimId = "/repo/node_modules/vinext/dist/shims/dynamic-preload-chunks.js";
  const clientReferencesId = "\0virtual:vite-rsc/client-references";

  function transformWith(plugin: Plugin, code: string, id: string): string | null {
    (plugin.configResolved as (config: unknown) => void).call(plugin, { plugins: [] });
    const result = (plugin.transform as (code: string, id: string) => { code: string } | null).call(
      plugin,
      code,
      id,
    );
    return result?.code ?? null;
  }

  it("appends an undefined key to plugin-rsc's own module when vinext's loaders are not in use", () => {
    const plugin = createDynamicPreloadChunksReferencePlugin({
      dynamicPreloadChunksShimId: shimId,
    });
    const code = transformWith(plugin, "export default {};\n", clientReferencesId);

    expect(code).toBe(
      "export default {};\n\nexport const dynamicPreloadChunksReferenceKey = undefined;\n",
    );
  });

  it("leaves other modules alone", () => {
    const plugin = createDynamicPreloadChunksReferencePlugin({
      dynamicPreloadChunksShimId: shimId,
    });

    expect(transformWith(plugin, "export default 1;\n", "/repo/app/page.tsx")).toBeNull();
  });
});
