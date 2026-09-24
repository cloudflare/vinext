import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VinextCacheFunctionInvocation } from "../packages/vinext/src/server/multi-stage.js";

const flight = vi.hoisted(() => {
  function isThenable(value: object): value is PromiseLike<unknown> {
    return "then" in value && typeof value.then === "function";
  }

  // Flight writes each object once, so repeated references and cycles decode
  // to one shared value. A promise is serialized as its resolved value without
  // its own fields, and decodes to a thenable whose own enumerable fields are
  // React's internal chunk state.
  function roundTrip(value: unknown): unknown {
    const decoded = new Map<object, unknown>();
    const decode = (value: unknown): unknown => {
      if (typeof value !== "object" || value === null) return value;
      if (decoded.has(value)) return decoded.get(value);
      if (isThenable(value)) {
        const chunk = Object.assign(Promise.resolve(value).then(decode), {
          status: "pending",
          value: null,
          reason: null,
        });
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

  it("scans and serializes one read of each getter", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    let reads = 0;
    const record: Record<string, unknown> = {
      get wrapped() {
        reads++;
        return Promise.resolve({ params: makeThenableParams({ slug: String(reads) }) });
      },
    };
    record.self = record;
    const shared = { record };
    const args = [
      shared,
      shared,
      Promise.resolve(record),
      new Map([["record", record]]),
      makeThenableParams({ record }),
    ];

    type Wrapped = { params: Promise<unknown> & { slug: string } };
    type Restored = { wrapped: Promise<Wrapped>; self: unknown };
    const [restoredShared, restoredAlias, restoredPromise, restoredMap, restoredOuter] =
      decodeCacheArguments(flight.roundTrip(await encodeCacheArguments(args))) as [
        { record: Restored },
        unknown,
        Promise<Restored>,
        Map<string, Restored>,
        Promise<{ record: Restored }> & { record: Restored },
      ];

    expect(reads).toBe(1);
    expect(Object.getOwnPropertyDescriptor(record, "wrapped")).toHaveProperty("get");
    const restored = restoredShared.record;
    const { params } = await restored.wrapped;
    expect(params.slug).toBe("1");
    expect(await params).toEqual({ slug: "1" });
    expect(restored.self).toBe(restored);
    expect(restoredAlias).toBe(restoredShared);
    expect(await restoredPromise).toBe(restored);
    expect(restoredMap.get("record")).toBe(restored);
    expect(restoredOuter.record).toBe(restored);
    expect((await restoredOuter).record).toBe(restored);
  });

  it("copies values that point back at a getter's ancestors", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    let reads = 0;
    const getterRecord = {
      get params() {
        reads++;
        return makeThenableParams({ slug: String(reads) });
      },
    };
    const sibling: Record<string, unknown> = {};
    const root = { getterRecord, sibling, siblings: new Set([sibling]) };
    sibling.parent = root;
    sibling.later = Promise.resolve([root]);

    type Root = {
      getterRecord: { params: Promise<unknown> & { slug: string } };
      sibling: { parent: unknown; later: Promise<unknown[]> };
      siblings: Set<unknown>;
    };
    const [restored] = decodeCacheArguments(
      flight.roundTrip(await encodeCacheArguments([root])),
    ) as [Root];

    expect(reads).toBe(1);
    expect(restored.getterRecord.params.slug).toBe("1");
    expect(restored.sibling.parent).toBe(restored);
    expect((await restored.sibling.later)[0]).toBe(restored);
    expect(restored.siblings.has(restored.sibling)).toBe(true);
  });

  it("scans every array index Flight serializes", async () => {
    const { decodeCacheArguments, encodeCacheArguments } =
      await import("../packages/vinext/src/shims/cache-callable-runtime.js");
    const { makeThenableParams } = await import("../packages/vinext/src/shims/thenable-params.js");
    let hiddenReads = 0;
    const hidden: unknown[] = [];
    Object.defineProperty(hidden, 0, {
      enumerable: false,
      get() {
        hiddenReads++;
        return makeThenableParams({ slug: `hidden-${hiddenReads}` });
      },
    });
    let sparseReads = 0;
    const sparse: unknown[] = [];
    sparse.length = 3;
    Object.defineProperty(sparse, 0, {
      enumerable: true,
      get() {
        sparseReads++;
        return makeThenableParams({ slug: `sparse-${sparseReads}` });
      },
    });

    type Params = Promise<unknown> & { slug: string };
    const [restoredHidden, restoredSparse] = decodeCacheArguments(
      flight.roundTrip(await encodeCacheArguments([hidden, sparse])),
    ) as [Params[], Params[]];

    expect(hiddenReads).toBe(1);
    expect(sparseReads).toBe(1);
    expect(restoredHidden).toHaveLength(1);
    expect(restoredHidden[0].slug).toBe("hidden-1");
    expect(await restoredHidden[0]).toEqual({ slug: "hidden-1" });
    expect(restoredSparse).toHaveLength(3);
    expect(restoredSparse[0].slug).toBe("sparse-1");
    expect(restoredSparse.slice(1)).toEqual([undefined, undefined]);
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
