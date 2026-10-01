import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import {
  registerCachedFunction,
  replayCachedFunction,
} from "../packages/vinext/src/shims/cache-runtime.js";

vi.mock("@vitejs/plugin-rsc/react/rsc", () => {
  throw new Error("Flight unavailable");
});

beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

describe("use cache without Flight", () => {
  it.each([false, true])(
    "does not conflate object aliases without Flight (reverse: %s)",
    async (reverse) => {
      const cached = registerCachedFunction(
        async (first: object, second: object) => first === second,
        "test:json-alias",
      );
      for (const same of reverse ? [false, true, false] : [true, false, true]) {
        const value = { data: "same" };
        expect(await cached(value, same ? value : { data: "same" })).toBe(same);
      }
    },
  );
  it("rejects Flight replay before executing when the codec is unavailable", async () => {
    const fn = vi.fn(async () => "must not run");
    const cached = registerCachedFunction(fn, "test:no-flight-replay");
    await expect(
      replayCachedFunction(cached, { version: 1, reply: '["expected"]' }),
    ).rejects.toThrow("without Flight");
    expect(fn).not.toHaveBeenCalled();
  });

  it("separates non-finite numbers, null, and signed zero", async () => {
    const fn = vi.fn(async (value: number | null) =>
      value === null ? "null" : Object.is(value, -0) ? "-0" : String(value),
    );
    const cached = registerCachedFunction(fn, "test:fallback-numbers");
    for (const value of [NaN, null, Infinity, -Infinity, -0, 0]) {
      const expected = value === null ? "null" : Object.is(value, -0) ? "-0" : String(value);
      expect(await cached(value)).toBe(expected);
      expect(await cached(value)).toBe(expected);
    }
    expect(fn).toHaveBeenCalledTimes(6);
  });
  it.each([
    ["File", () => new File(["private"], "private.txt")],
    ["Blob", () => new Blob(["private"])],
    ["Map", () => new Map([["private", "value"]])],
    ["Set", () => new Set(["private"])],
    ["FormData", () => new FormData()],
    ["typed array", () => new Uint8Array([1])],
    ["Promise<File>", () => Promise.resolve(new File(["private"], "private.txt"))],
  ])("bypasses caching for %s instead of flattening it", async (_label, input) => {
    const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
    const cached = registerCachedFunction(fn, "test:fallback");
    const first = await cached({ nested: [input()] });
    expect(await cached({ nested: [input()] })).not.toBe(first);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("caches promise values together with their own fields", async () => {
    const fn = vi.fn(async (value: Promise<string> & { label: string }) => ({
      value: await value,
      label: value.label,
    }));
    const cached = registerCachedFunction(fn, "test:fallback-promise");
    const input = (value: string, label = "same") =>
      Object.assign(Promise.resolve(value), { label });
    expect(await cached(input("private"))).toEqual({ value: "private", label: "same" });
    expect(await cached(input("public"))).toEqual({ value: "public", label: "same" });
    expect(await cached(input("private", "different"))).toEqual({
      value: "private",
      label: "different",
    });
    await cached(input("private"));
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("still caches ordinary arguments and dates", async () => {
    const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
    const cached = registerCachedFunction(fn, "test:fallback-safe");
    const input = () => ({ value: [1, "a", null], date: new Date(100) });
    expect(await cached(input())).toBe(await cached(input()));
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
