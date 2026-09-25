import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { VinextCacheFunctionInvocation } from "../packages/vinext/src/server/multi-stage.js";

const flight = vi.hoisted(() => {
  function isThenable(value: object): value is PromiseLike<unknown> {
    return "then" in value && typeof value.then === "function";
  }

  // Like React's `ReactPromise`: it inherits from `Promise.prototype` without
  // being a native promise, its `then` returns nothing, and its own enumerable
  // fields are React's internal chunk state.
  const chunkPromises = new WeakMap<object, Promise<unknown>>();
  const chunkPrototype = Object.create(Promise.prototype, {
    // eslint-disable-next-line unicorn/no-thenable
    then: {
      value(
        this: object,
        resolve?: (value: unknown) => void,
        reject?: (reason: unknown) => void,
      ): void {
        void chunkPromises.get(this)?.then(resolve, reject);
      },
    },
  });
  function createChunk(promise: Promise<unknown>): object {
    const chunk: Record<string, unknown> = Object.assign(Object.create(chunkPrototype), {
      status: "pending",
      value: null,
      reason: null,
    });
    chunkPromises.set(chunk, promise);
    promise.then(
      (value) => {
        Object.assign(chunk, { status: "fulfilled", value });
      },
      (reason) => {
        Object.assign(chunk, { status: "rejected", reason });
      },
    );
    return chunk;
  }

  // Flight writes each object once, so repeated references and cycles decode
  // to one shared value. A promise is serialized as its resolved value without
  // its own fields, and decodes to a React chunk.
  function roundTrip(value: unknown): unknown {
    const decoded = new Map<object, unknown>();
    const decode = (value: unknown): unknown => {
      if (typeof value !== "object" || value === null) return value;
      if (decoded.has(value)) return decoded.get(value);
      if (isThenable(value)) {
        const chunk = createChunk(Promise.resolve(value).then(decode));
        decoded.set(value, chunk);
        return chunk;
      }
      if (Array.isArray(value)) {
        const items: unknown[] = [];
        decoded.set(value, items);
        for (const item of value) items.push(decode(item));
        return items;
      }
      if (value instanceof Map) {
        const map = new Map();
        decoded.set(value, map);
        for (const [key, item] of value) map.set(decode(key), decode(item));
        return map;
      }
      if (value instanceof Set) {
        const set = new Set();
        decoded.set(value, set);
        for (const item of value) set.add(decode(item));
        return set;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype) return value;
      const record: Record<string, unknown> = {};
      decoded.set(value, record);
      for (const [key, field] of Object.entries(value)) record[key] = decode(field);
      return record;
    };
    return decode(value);
  }

  const payloads = new Map<string, unknown>();
  return { payloads, roundTrip };
});

vi.mock("@vitejs/plugin-rsc/utils/encryption-runtime", () => ({
  async encryptActionBoundArgs(value: unknown) {
    const encrypted = `encrypted:${flight.payloads.size}`;
    flight.payloads.set(encrypted, flight.roundTrip(value));
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

    const decoded = decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
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
    const decoded = decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
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

  it("passes arguments to Flight unchanged and collects each promise's fields once", async () => {
    const { encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const params = makeThenableParams({ slug: "a" });
    const node: Record<string, unknown> = { params, map: new Map([["params", params]]) };
    node.self = node;
    const args = [node, new Set([params, Promise.resolve("plain")])];

    const encoded = await encodeCacheArguments(args);

    expect(encoded.args).toBe(args);
    expect(encoded.thenableObjects).toEqual([{ fields: { slug: "a" }, promise: params }]);
    expect(encoded.thenableObjects[0]?.promise).toBe(params);
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

    const decoded = decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
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
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const map = new Map<string, unknown>([["params", makeThenableParams({ slug: "a" })]]);
    map.set("self", map);
    const set = new Set<unknown>([map]);
    set.add(set);
    const args = [map, set];

    const decoded = decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
      Map<string, unknown>,
      Set<unknown>,
    ];

    expect(decoded[0]).not.toBe(map);
    expect(decoded[0].get("self")).toBe(decoded[0]);
    expect((decoded[0].get("params") as { slug: string }).slug).toBe("a");
    const members = [...decoded[1]];
    expect(members).toHaveLength(2);
    expect(members[0]).toBe(decoded[0]);
    expect(members[1]).toBe(decoded[1]);
  });

  it("keeps collections shared between a promise's fields and its resolved value", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const nested = makeThenableParams({ id: "b" });
    const children = new Map<string, unknown>([["nested", nested]]);
    children.set("self", children);
    const siblings = new Set<unknown>([nested]);
    const outer = Object.assign(Promise.resolve({ children, siblings }), { children, siblings });
    const args = [outer];

    type Collections = { children: Map<string, unknown>; siblings: Set<unknown> };
    const [restored] = decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
      Promise<Collections> & Collections,
    ];
    const awaited = await restored;

    expect(awaited.children).toBe(restored.children);
    expect(awaited.siblings).toBe(restored.siblings);
    expect(restored.children.get("self")).toBe(restored.children);
    const restoredNested = restored.children.get("nested") as Promise<unknown> & { id: string };
    expect(restoredNested.id).toBe("b");
    expect(restored.siblings.has(restoredNested)).toBe(true);
  });

  it("restores params inside resolved promise values", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const params = makeThenableParams({ slug: "a" });
    const rejected = Promise.reject(new Error("rejected"));
    const args = [Promise.resolve({ nested: params, deeper: Promise.resolve([params]) }), rejected];

    const encoded = await encodeCacheArguments(args);
    expect(encoded.thenableObjects).toEqual([{ fields: { slug: "a" }, promise: params }]);

    type Wrapped = { nested: Promise<unknown> & { slug: string }; deeper: Promise<unknown[]> };
    const [wrapper, restoredRejected] = decodeCacheArguments(flight.roundTrip(encoded)) as [
      Promise<Wrapped>,
      Promise<unknown>,
    ];
    const { nested, deeper } = await wrapper;

    expect(nested.slug).toBe("a");
    expect(await nested).toEqual({ slug: "a" });
    expect((await deeper)[0]).toBe(nested);
    await expect(restoredRejected).rejects.toThrow("rejected");
  });

  it("records params added to the arguments while a promise is pending", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const shared: Record<string, unknown> = {};
    const later = Promise.resolve().then(() => {
      shared.params = makeThenableParams({ slug: "a" });
      return shared;
    });
    const args = [shared, later];

    const encoded = await encodeCacheArguments(args);
    expect(encoded.thenableObjects).toEqual([{ fields: { slug: "a" }, promise: shared.params }]);

    const [restored, restoredLater] = decodeCacheArguments(flight.roundTrip(encoded)) as [
      { params: Promise<unknown> & { slug: string } },
      Promise<unknown>,
    ];
    expect(restored.params.slug).toBe("a");
    expect(await restored.params).toEqual({ slug: "a" });
    expect(await restoredLater).toBe(restored);
  });

  it("scans every array index Flight serializes", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const hidden: unknown[] = [];
    Object.defineProperty(hidden, 0, {
      enumerable: false,
      value: makeThenableParams({ slug: "hidden" }),
    });
    const sparse: unknown[] = [makeThenableParams({ slug: "sparse" })];
    sparse.length = 3;

    type Params = Promise<unknown> & { slug: string };
    const [restoredHidden, restoredSparse] = decodeCacheArguments(
      flight.roundTrip(await encodeCacheArguments([hidden, sparse])),
    ) as [Params[], Params[]];

    expect(restoredHidden).toHaveLength(1);
    expect(restoredHidden[0].slug).toBe("hidden");
    expect(await restoredHidden[0]).toEqual({ slug: "hidden" });
    expect(restoredSparse).toHaveLength(3);
    expect(restoredSparse[0].slug).toBe("sparse");
    expect(restoredSparse.slice(1)).toEqual([undefined, undefined]);
  });

  it("scans an inherited data property at an array hole", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const params = makeThenableParams({ slug: "inherited" });
    const sparse: unknown[] = ["first"];
    sparse.length = 2;
    Object.setPrototypeOf(sparse, Object.create(Array.prototype, { 1: { value: params } }));

    const encoded = await encodeCacheArguments([sparse]);
    expect(encoded.thenableObjects).toEqual([{ fields: { slug: "inherited" }, promise: params }]);

    type Params = Promise<unknown> & { slug: string };
    const [restored] = decodeCacheArguments(flight.roundTrip(encoded)) as [[string, Params]];
    expect(restored[1].slug).toBe("inherited");
    expect(await restored[1]).toEqual({ slug: "inherited" });
  });

  it("refuses to encode arguments that hold getters, without running them", async () => {
    const { encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    let reads = 0;
    const getter = {
      get() {
        reads++;
        return makeThenableParams({ slug: String(reads) });
      },
    };
    const record = Object.defineProperty({}, "params", { ...getter, enumerable: true });
    const promiseField = Object.defineProperty(Promise.resolve({ slug: "a" }), "slug", {
      ...getter,
      enumerable: true,
    });
    const inherited: unknown[] = ["first"];
    inherited.length = 2;
    Object.setPrototypeOf(inherited, Object.create(Array.prototype, { 1: getter }));

    for (const value of [record, promiseField, inherited]) {
      await expect(encodeCacheArguments([{ value }])).rejects.toThrow(
        "Cache function arguments with getters cannot be replayed",
      );
    }
    expect(reads).toBe(0);
  });

  it("does not record a replay for arguments that hold getters", async () => {
    const { registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { MemoryCacheHandler, setCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);

    const cached = registerCachedFunction(
      async (options: { slug: string }) => `${options.slug}:${crypto.randomUUID()}`,
      "test:getter-args",
      "",
      { argumentCount: 1, serverReferenceId: "test#getter-args" },
    );

    await cached({
      get slug() {
        return "a";
      },
    });

    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[2]).not.toHaveProperty("cacheFunctionInvocation");
  });

  it("keeps params fields in captures next to a getter", async () => {
    const { encryptCacheCaptures, registerCachedFunction } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const { MemoryCacheHandler, setCacheHandler } =
      await import("../packages/vinext/src/shims/cache.js");
    setCacheHandler(new MemoryCacheHandler());

    let reads = 0;
    type Captures = [{ slug: string }, Promise<unknown> & { slug: string }];
    const cached = registerCachedFunction(
      // The capture envelope is replaced by the decrypted captures.
      async (captures: unknown) => {
        const [options, params] = captures as Captures;
        return { option: options.slug, param: params.slug, awaited: await params };
      },
      "test:getter-captures",
      "",
      { serverReferenceId: "test#getter-captures" },
    );

    const result = await cached(
      encryptCacheCaptures([
        {
          get slug() {
            reads++;
            return "captured";
          },
        },
        makeThenableParams({ slug: "param" }),
      ]),
    );

    expect(result).toEqual({ option: "captured", param: "param", awaited: { slug: "param" } });
    // Flight reads the getter once to serialize it; the scan does not.
    expect(reads).toBe(1);
  });

  it("replays arguments with setter-only properties", async () => {
    const { encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    const params = makeThenableParams({ slug: "a" });
    const record = Object.defineProperty({ params }, "sink", { enumerable: true, set() {} });
    const sparse: unknown[] = [params];
    sparse.length = 2;
    Object.setPrototypeOf(sparse, Object.create(Array.prototype, { 1: { set() {} } }));

    const encoded = await encodeCacheArguments([record, sparse]);

    expect(encoded.thenableObjects).toEqual([{ fields: { slug: "a" }, promise: params }]);
  });

  it("rejects payloads without recorded promise fields", async () => {
    const { decodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");

    expect(() => decodeCacheArguments(["legacy"])).toThrow("Invalid cache function arguments");
    expect(() => decodeCacheArguments({ args: [], encodedValuePaths: [] })).toThrow(
      "Invalid cache function arguments",
    );
    expect(() =>
      decodeCacheArguments({ args: [], thenableObjects: [{ fields: {}, promise: {} }] }),
    ).toThrow("Invalid cache function arguments");
    expect(() =>
      decodeCacheArguments({
        args: [],
        thenableObjects: [{ fields: "slug", promise: Promise.resolve() }],
      }),
    ).toThrow("Invalid cache function arguments");
  });
});
