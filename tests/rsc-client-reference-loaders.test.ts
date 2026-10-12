import { describe, expect, it } from "vite-plus/test";
import { selectDynamicPreloadChunksReferenceKey } from "../packages/vinext/src/plugins/rsc-client-reference-loaders.js";

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
