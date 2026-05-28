// Ported from Next.js: test/unit/is-serializable-props.test.ts
// https://github.com/vercel/next.js/blob/canary/test/unit/is-serializable-props.test.ts
//
// vinext implements its own copy of `isSerializableProps` so Pages Router
// `getStaticProps` / `getServerSideProps` surface a clear error (instead of
// rendering an empty page) when they return non-JSON-serializable values.
// Tracked in vinext#1478.

import { describe, expect, it } from "vite-plus/test";
import {
  isSerializableProps,
  SerializableError,
} from "../packages/vinext/src/server/pages-serializable-props.js";

describe("isSerializableProps", () => {
  it("allows empty props", () => {
    expect(isSerializableProps("/", "getStaticProps", {})).toBe(true);
  });

  it("allows nested JSON-safe values", () => {
    expect(
      isSerializableProps("/", "getStaticProps", {
        str: "foo",
        num: 0,
        bool: true,
        nul: null,
        arr: [1, "two", null, { a: 1 }],
        obj: { nested: { deep: "ok" } },
      }),
    ).toBe(true);
  });

  it("rejects top-level non-plain values", () => {
    expect(() => isSerializableProps("/", "getStaticProps", null)).toThrow(SerializableError);
    expect(() => isSerializableProps("/", "getStaticProps", undefined)).toThrow(SerializableError);
    expect(() => isSerializableProps("/", "getStaticProps", [])).toThrow(
      /received: `\[object Array\]`/,
    );
  });

  it("rejects Date inside props", () => {
    expect(() => isSerializableProps("/non-json", "getStaticProps", { date: new Date(0) })).toThrow(
      /Error serializing `\.date` returned from `getStaticProps` in "\/non-json"/,
    );
    expect(() => isSerializableProps("/non-json", "getStaticProps", { date: new Date(0) })).toThrow(
      /`object` \("\[object Date\]"\) cannot be serialized as JSON/,
    );
  });

  it("rejects functions inside props", () => {
    expect(() => isSerializableProps("/", "getServerSideProps", { fn: () => 1 })).toThrow(
      /`function` cannot be serialized as JSON/,
    );
  });

  it("rejects undefined nested values with a helpful message", () => {
    expect(() => isSerializableProps("/", "getStaticProps", { foo: undefined })).toThrow(
      /`undefined` cannot be serialized as JSON\. Please use `null` or omit this value\./,
    );
  });

  it("detects circular references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => isSerializableProps("/", "getStaticProps", a)).toThrow(
      /Circular references cannot be expressed in JSON/,
    );
  });

  it("uses bracket notation for non-identifier keys in the path", () => {
    expect(() => isSerializableProps("/", "getStaticProps", { "weird key": new Date() })).toThrow(
      /Error serializing `\["weird key"\]`/,
    );
  });
});
