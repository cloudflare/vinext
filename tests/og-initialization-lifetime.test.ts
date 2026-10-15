import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

// @vercel/og awaits its isolate-wide WASM and font initialization before its
// stream produces the first chunk, so a held first chunk stands in for it.
const og = vi.hoisted(() => {
  let release: () => void = () => {};
  const initialized = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { initialized, release: () => release() };
});

// @vercel/og is a dependency of vinext, not of the repo root.
vi.mock("../packages/vinext/node_modules/@vercel/og", () => ({
  ImageResponse: class extends Response {
    constructor() {
      super(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await og.initialized;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        }),
      );
    }
  },
}));

describe("next/og initialization lifetime", () => {
  // workerd drops a canceled request's pending I/O, so the request that loads
  // @vercel/og must outlive the initialization every later image awaits.
  it("keeps the request that loads @vercel/og alive until its initialization settles", async () => {
    const { ImageResponse } = await import("../packages/vinext/src/shims/og.js");
    const element = React.createElement("div");
    const creator = { waitUntil: vi.fn() };
    const joiner = { waitUntil: vi.fn() };

    const first = runWithExecutionContext(creator, () => new ImageResponse(element));
    const second = runWithExecutionContext(joiner, () => new ImageResponse(element));

    expect(creator.waitUntil).toHaveBeenCalledOnce();
    expect(joiner.waitUntil).not.toHaveBeenCalled();
    const lifetime = creator.waitUntil.mock.calls[0]![0] as Promise<void>;
    let settled = false;
    void lifetime.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    og.release();
    await lifetime;
    for (const response of [first, second]) {
      expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(new Uint8Array([1]));
    }
  });
});
