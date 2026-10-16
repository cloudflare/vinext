import React from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWithExecutionContext } from "../packages/vinext/src/shims/request-context.js";

const og = vi.hoisted(() => ({ imports: 0 }));

// @vercel/og is a dependency of vinext, not of the repo root. The first
// import fails, as a chunk that fails to load would.
vi.mock("../packages/vinext/node_modules/@vercel/og", () => {
  og.imports += 1;
  if (og.imports === 1) throw new Error("failed to load @vercel/og");
  return {
    ImageResponse: class extends Response {
      constructor() {
        super(new Uint8Array([1]));
      }
    },
  };
});

describe("next/og import failure", () => {
  // Next.js imports @vercel/og for every image, so one failed load does not
  // fail every later image in the isolate.
  it("imports @vercel/og again after a failed import", async () => {
    const { ImageResponse } = await import("../packages/vinext/src/shims/og.js");
    const element = React.createElement("div");

    // vitest wraps a throwing mock factory's error in its own.
    await expect(new ImageResponse(element).arrayBuffer()).rejects.toMatchObject({
      cause: { message: "failed to load @vercel/og" },
    });
    expect(new Uint8Array(await new ImageResponse(element).arrayBuffer())).toEqual(
      new Uint8Array([1]),
    );
    expect(og.imports).toBe(2);

    // A successful import stays memoized: the next image starts no new
    // initialization, so it keeps no request alive.
    const later = { waitUntil: vi.fn() };
    const response = runWithExecutionContext(later, () => new ImageResponse(element));
    expect(new Uint8Array(await (await response).arrayBuffer())).toEqual(new Uint8Array([1]));
    expect(later.waitUntil).not.toHaveBeenCalled();
  });
});
