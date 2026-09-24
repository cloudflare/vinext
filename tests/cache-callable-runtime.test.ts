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
  // Repeated references decode to one shared value; cycles are not modeled.
  async function roundTrip(value: unknown): Promise<unknown> {
    const decoded = new Map<object, Promise<[unknown]>>();
    // Results are boxed because an async function adopts a returned thenable,
    // which would replace the chunk with its resolved value.
    const decode = (value: unknown): Promise<[unknown]> => {
      if (typeof value !== "object" || value === null) return Promise.resolve([value]);
      let result = decoded.get(value);
      if (!result) {
        result = decodeObject(value);
        decoded.set(value, result);
      }
      return result;
    };
    const decodeObject = async (value: object): Promise<[unknown]> => {
      if (isThenable(value)) {
        const [resolved] = await decode(await value);
        return [createChunk(resolved)];
      }
      if (Array.isArray(value)) {
        return [(await Promise.all(value.map(decode))).map(([item]) => item)];
      }
      if (value instanceof Map) {
        const [entries] = await decode([...value]);
        return [new Map(entries as Array<[unknown, unknown]>)];
      }
      if (value instanceof Set) {
        const [items] = await decode([...value]);
        return [new Set(items as unknown[])];
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return [value];
      const entries = await Promise.all(
        Object.entries(value).map(async ([key, field]) => [key, (await decode(field))[0]] as const),
      );
      return [Object.fromEntries(entries)];
    };
    // Callers pass a plain payload object, so the unboxed result is never a thenable.
    const [result] = await decode(value);
    return result;
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

  it("keeps shared references to params, their values and promises", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const segments = ["a", "b"];
    const params = makeThenableParams({ slug: segments, nested: makeThenableParams({ id: "c" }) });
    const shared = { params };
    const pending = Promise.resolve("pending");
    const args = [shared, shared, params, pending, pending];

    type RestoredParams = Promise<{ slug: string[]; nested: unknown }> & {
      slug: string[];
      nested: Promise<unknown>;
    };
    const decoded = decodeCacheArguments(await flight.roundTrip(encodeCacheArguments(args))) as [
      { params: RestoredParams },
      { params: RestoredParams },
      RestoredParams,
      Promise<unknown>,
      Promise<unknown>,
    ];

    expect(decoded[1]).toBe(decoded[0]);
    expect(decoded[2]).toBe(decoded[0].params);
    expect(decoded[4]).toBe(decoded[3]);

    const restored = decoded[2];
    const awaited = await restored;
    expect(restored.slug).toEqual(segments);
    expect(awaited.slug).toBe(restored.slug);
    expect(awaited.nested).toBe(restored.nested);
    expect(Object.keys(restored.nested)).toEqual(["id"]);
  });

  it("encodes cycles once and leaves values without params as-is", async () => {
    const { encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const other = { list: [1, 2] };
    const node: Record<string, unknown> = { params: makeThenableParams({ slug: "a" }), other };
    node.self = node;

    const { args, encodedValuePaths } = encodeCacheArguments([node, other, new Map([["a", 1]])]);
    const encodedNode = args[0] as Record<string, unknown>;

    expect(encodedNode).not.toBe(node);
    expect(encodedNode.self).toBe(encodedNode);
    expect(encodedNode.other).toBe(other);
    expect(args[1]).toBe(other);
    expect(args[2]).toBeInstanceOf(Map);
    expect(encodedValuePaths).toEqual([[0, "params"]]);
  });

  it("restores params inside Maps and Sets", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const params = makeThenableParams({ slug: "a" });
    const map = new Map<unknown, unknown>([
      ["params", params],
      [params, "keyed"],
    ]);
    const args = [map, new Set([params]), params];

    const decoded = decodeCacheArguments(await flight.roundTrip(encodeCacheArguments(args))) as [
      Map<unknown, unknown>,
      Set<unknown>,
      Promise<unknown> & { slug: string },
    ];

    const restored = decoded[2];
    expect(restored.slug).toBe("a");
    expect(await restored).toEqual({ slug: "a" });
    expect(decoded[0]).toBeInstanceOf(Map);
    expect([...decoded[0]]).toEqual([
      ["params", restored],
      [restored, "keyed"],
    ]);
    expect(decoded[0].get("params")).toBe(restored);
    expect(decoded[0].get(restored)).toBe("keyed");
    expect(decoded[1]).toBeInstanceOf(Set);
    expect(decoded[1].has(restored)).toBe(true);
    expect(decoded[1].size).toBe(1);
  });

  it("restores cycles through Maps and Sets", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const params = Object.assign(Promise.resolve({ slug: "a" }), { slug: "a" });
    const map = new Map<string, unknown>([["params", params]]);
    map.set("self", map);
    const set = new Set<unknown>([map]);
    set.add(set);

    // The Flight mock does not model cycles, so decode the encoded value directly.
    const decoded = decodeCacheArguments(encodeCacheArguments([map, set])) as [
      Map<string, unknown>,
      Set<unknown>,
    ];

    expect(decoded[0]).not.toBe(map);
    expect(decoded[0].get("self")).toBe(decoded[0]);
    expect(decoded[0].get("params")).toMatchObject({ slug: "a" });
    const members = [...decoded[1]];
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(decoded[0]);
    expect(members[1]).toBe(decoded[1]);
  });

  it("rejects payloads without recorded argument shapes", async () => {
    const { decodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");

    expect(() => decodeCacheArguments(["legacy"])).toThrow("Invalid cache function arguments");
    expect(() => decodeCacheArguments({ args: [{}], encodedValuePaths: [[0, "missing"]] })).toThrow(
      "Invalid cache function arguments",
    );
    expect(() => decodeCacheArguments({ args: [{ slug: "a" }], encodedValuePaths: [[0]] })).toThrow(
      "Invalid cache function arguments",
    );
    expect(() =>
      decodeCacheArguments({
        args: [{ kind: "map", entries: [["a"]] }],
        encodedValuePaths: [[0]],
      }),
    ).toThrow("Invalid cache function arguments");
  });
});
