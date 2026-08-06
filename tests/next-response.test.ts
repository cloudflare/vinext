import { describe, expect, it } from "vitest";

describe("NextResponse", () => {
  // Next.js delegates JSON serialization to Response.json(), including its
  // top-level serialization failures:
  // https://github.com/vercel/next.js/blob/491f78099c3ea23be14e66c6d848b50204590e90/packages/next/src/server/web/spec-extension/response.ts#L109-L115
  it.each([
    { name: "undefined", value: undefined },
    { name: "a function", value: () => undefined },
    { name: "a symbol", value: Symbol("invalid-json") },
  ])("rejects $name as a JSON response body", async ({ value }) => {
    const { NextResponse } = await import("../packages/vinext/src/shims/server.js");

    expect(() => NextResponse.json(value)).toThrow(TypeError);
  });
});
