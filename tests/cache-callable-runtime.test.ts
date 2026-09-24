import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VinextCacheFunctionInvocation } from "../packages/vinext/src/server/multi-stage.js";

const flight = vi.hoisted(() => {
  // Mirrors React Flight's client decoding of a promise: a thenable whose own
  // enumerable fields are React's internal chunk state.
  function createChunk(value: unknown): Promise<unknown> {
    return Object.assign(Promise.resolve(value), { status: "fulfilled", value, reason: null });
  }

  function isThenable(value: object): value is PromiseLike<unknown> {
    return "then" in value && typeof value.then === "function";
  }

  // Flight serializes a promise as its resolved value and drops its own fields.
  // Results are boxed because an async function adopts a returned thenable,
  // which would replace the chunk with its resolved value.
  async function decode(value: unknown): Promise<[unknown]> {
    if (typeof value !== "object" || value === null) return [value];
    if (isThenable(value)) {
      const [resolved] = await decode(await value);
      return [createChunk(resolved)];
    }
    if (Array.isArray(value)) {
      return [(await Promise.all(value.map(decode))).map(([item]) => item)];
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return [value];
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, field]) => [key, (await decode(field))[0]] as const),
    );
    return [Object.fromEntries(entries)];
  }

  // Callers pass a plain payload object, so the unboxed result is never a thenable.
  async function roundTrip(value: unknown): Promise<unknown> {
    const [decoded] = await decode(value);
    return decoded;
  }

  const payloads = new Map<string, unknown>();
  return { payloads, roundTrip };
});

vi.mock("@vitejs/plugin-rsc/utils/encryption-runtime", () => ({
  async encryptActionBoundArgs(value: unknown) {
    const encrypted = `encrypted:${flight.payloads.size}`;
    flight.payloads.set(encrypted, await flight.roundTrip(value));
    return encrypted;
  },
  async decryptActionBoundArgs(encrypted: Promise<string>) {
    return flight.payloads.get(await encrypted);
  },
}));

describe("cache-callable-runtime", () => {
  beforeEach(() => {
    flight.payloads.clear();
  });

  it("replays promise params under the cache key the original call used", async () => {
    const { invokeCacheFunction, registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const { MemoryCacheHandler, setCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();
    const get = vi.spyOn(handler, "get");
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);

    const syncSlugs: unknown[] = [];
    const awaitedParams: unknown[] = [];
    const cached = registerCachedFunction(
      async (params: Promise<{ slug: string; value: string }> & { slug: string }) => {
        syncSlugs.push(params.slug);
        awaitedParams.push({ ...(await params) });
        return crypto.randomUUID();
      },
      "test:replay-params",
      "",
      { argumentCount: 1, serverReferenceId: "test#replay-params" },
    );

    // The params proxy hides `value` from its own keys but resolves to it.
    await cached(makeThenableParams({ slug: "replayed", value: "reserved" }));
    const invocation = set.mock.calls[0]?.[2]?.cacheFunctionInvocation as
      | VinextCacheFunctionInvocation
      | undefined;
    expect(invocation).toBeDefined();
    if (!invocation) return;

    // Treat the entry as missing so the replay executes and writes.
    get.mockResolvedValueOnce(null);
    await invokeCacheFunction(invocation, async () => cached);

    const originalKey = get.mock.calls[0]?.[0];
    expect(get.mock.calls[1]?.[0]).toBe(originalKey);
    expect(set.mock.calls[1]?.[0]).toBe(originalKey);
    expect(syncSlugs).toEqual(["replayed", "replayed"]);
    expect(awaitedParams).toEqual([
      { slug: "replayed", value: "reserved" },
      { slug: "replayed", value: "reserved" },
    ]);
  });

  it("restores promise-augmented objects and adopts Flight promises", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const date = new Date(0);
    const params = makeThenableParams({ slug: "a", nested: makeThenableParams({ id: "b" }) });
    const first = { params, date };
    const args = [first, Promise.resolve({ plain: true }), "value"];

    const decoded = decodeCacheArguments(await flight.roundTrip(encodeCacheArguments(args))) as [
      { params: Promise<unknown> & Record<string, unknown>; date: Date },
      Promise<unknown>,
      string,
    ];

    // The caller's arguments are left untouched.
    expect(first.params).toBe(params);
    expect(Object.keys(params)).toEqual(["slug", "nested"]);

    const restored = decoded[0].params;
    expect(restored).toBeInstanceOf(Promise);
    expect(restored.slug).toBe("a");
    expect(restored.nested).toBeInstanceOf(Promise);
    expect(Object.keys(restored.nested as object)).toEqual(["id"]);
    expect(await restored).toMatchObject({ slug: "a" });
    expect(decoded[0].date).toEqual(date);

    expect(decoded[1]).toBeInstanceOf(Promise);
    expect(Object.keys(decoded[1])).toEqual([]);
    expect(await decoded[1]).toEqual({ plain: true });
    expect(decoded[2]).toBe("value");
  });

  it("rejects payloads without recorded argument shapes", async () => {
    const { decodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");

    expect(() => decodeCacheArguments(["legacy"])).toThrow("Invalid cache function arguments");
    expect(() =>
      decodeCacheArguments({ args: [{}], thenableObjectPaths: [[0, "missing"]] }),
    ).toThrow("Invalid cache function arguments");
    expect(() =>
      decodeCacheArguments({ args: [{ slug: "a" }], thenableObjectPaths: [[0]] }),
    ).toThrow("Invalid cache function arguments");
  });
});
