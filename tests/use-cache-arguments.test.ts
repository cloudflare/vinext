import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import { registerCachedFunction } from "../packages/vinext/src/shims/cache-runtime.js";
import {
  CacheFlightFormData,
  snapshotFlightReply,
  flightArgumentsKey,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";
const replyToCacheKey = async (reply: string | FormData) =>
  flightArgumentsKey(await snapshotFlightReply(reply));

vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { loadCacheFlightCodec } = await import("./helpers/cache-flight-codec.js");
  return loadCacheFlightCodec();
});

const file = (name = "private.txt", content = "", lastModified = 111, type = "text/plain") =>
  new File([content], name, { lastModified, type });

describe("use cache argument identity", () => {
  beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

  it("snapshots the File that Flight emitted while other arguments are pending", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let read!: () => void;
    const observed = new Promise<void>((resolve) => {
      read = resolve;
    });
    let current = file("original", "A", 111);
    const input = {
      get "a:b"() {
        read();
        return current;
      },
    };
    const cached = registerCachedFunction(
      async (value: { "a:b": File }, _wait: Promise<void>) => ({
        name: value["a:b"].name,
        time: value["a:b"].lastModified,
      }),
      "test:binary-mutation",
    );
    const result = cached(input, pending);
    await observed;
    current = file("replacement", "B", 222);
    finish();
    expect(await result).toEqual({ name: "original", time: 111 });
    expect(await cached(input, Promise.resolve())).toEqual({ name: "replacement", time: 222 });
  });

  it.each(["", "private"])("resolves temporary references per invocation (%s)", async (variant) => {
    class Input {
      constructor(readonly label: string) {}
    }
    const first = new Input("first");
    const second = new Input("second");
    const fn = vi.fn(async (value: Input) => ({ value }));
    const cached = registerCachedFunction(fn, `test:temporary-return:${variant}`, variant);
    expect((await cached(first)).value).toBe(first);
    expect((await cached(second)).value).toBe(second);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "strips untransported File properties before execution (reverse: %s)",
    async (reverse) => {
      const fn = vi.fn(async (value: File & { tenant?: string }) => ({
        name: value.name,
        tenant: value.tenant,
        text: await value.text(),
      }));
      const cached = registerCachedFunction(fn, "test:file-decoration");
      for (const tenant of reverse ? ["public", "private"] : ["private", "public"]) {
        expect(await cached(Object.assign(file(), { tenant }))).toEqual({
          name: "private.txt",
          tenant: undefined,
          text: "",
        });
      }
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "normalizes File aliases outside Flight references (reverse: %s)",
    async (reverse) => {
      const fn = vi.fn(async (form: FormData, value: File) => form.get("file") === value);
      const cached = registerCachedFunction(fn, "test:form-alias");
      for (const same of reverse ? [false, true] : [true, false]) {
        const value = file();
        const form = new FormData();
        form.append("file", same ? value : file());
        expect(await cached(form, value)).toBe(false);
      }
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["colon", "getter", "iterable"])(
    "preserves File metadata and Blob hits through %s",
    async (kind) => {
      const wrap = (value: Blob) =>
        kind === "colon"
          ? { "a:b": value }
          : kind === "getter"
            ? {
                get "a:b"() {
                  return value;
                },
              }
            : {
                *[Symbol.iterator]() {
                  yield value;
                },
              };
      const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
      const cached = registerCachedFunction(fn, "test:binary-path");
      const first = await cached(wrap(file("blob", "X", 111)));
      expect(await cached(wrap(file("blob", "X", 222)))).not.toBe(first);
      expect(await cached(wrap(file("blob", "X", 111)))).toBe(first);
      const blob = await cached(wrap(new Blob(["X"])));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(await cached(wrap(new Blob(["X"])))).toBe(blob);
      expect(fn).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ["bytes", () => file("private.txt", "X")],
    ["name", () => file("public.txt")],
    ["timestamp", () => file("private.txt", "", 333)],
    ["type", () => file("private.txt", "", 111, "application/pdf")],
  ])("distinguishes File %s and reuses identical files", async (_label, different) => {
    const fn = vi.fn(async (value: File) => ({
      name: value.name,
      lastModified: value.lastModified,
      type: value.type,
      text: await value.text(),
    }));
    const cached = registerCachedFunction(fn, "test:file");
    const first = await cached(file());
    expect(await cached(different())).not.toEqual(first);
    expect(await cached(file())).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["object", (value: File) => ({ nested: [value] })],
    ["map", (value: File) => new Map([["file", value]])],
    ["set", (value: File) => new Set([value])],
    ["promise", (value: File) => Promise.resolve(value)],
    [
      "FormData",
      (value: File) => {
        const form = new FormData();
        form.append("upload", value);
        return form;
      },
    ],
  ])("includes File metadata inside a %s", async (_label, wrap) => {
    const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
    const cached = registerCachedFunction(fn, "test:nested-file");
    const first = await cached(wrap(file()));
    expect(await cached(wrap(file("private.txt", "", 333)))).not.toBe(first);
    expect(await cached(wrap(file()))).toBe(first);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Adapted from Next.js's "should cache complex args" regression:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/use-cache/use-cache.test.ts
  it.each([
    ["Blob", (n: number) => new Blob([new Uint8Array([n])])],
    ["ArrayBuffer", (n: number) => new Uint8Array([n]).buffer],
    ["typed array", (n: number) => new Uint8Array([n])],
    ["Date", (n: number) => new Date(n)],
    ["Map", (n: number) => new Map([["value", n]])],
    ["Set", (n: number) => new Set([n])],
  ])("preserves %s identity and stable repeat hits", async (_label, input) => {
    const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
    const cached = registerCachedFunction(fn, "test:built-in");
    const first = await cached(input(0xa1));
    expect(await cached(input(0xe2))).not.toBe(first);
    // Blob/typed-array transport wrappers receive a fresh timestamp each time.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await cached(input(0xa1))).toBe(first);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not equate a File named blob with a Blob", async () => {
    const cached = registerCachedFunction(
      async (value: Blob) => (value instanceof File ? value.lastModified : null),
      "test:blob-file",
    );
    expect(await cached(new Blob(["X"], { type: "text/plain" }))).toBe(0);
    expect(await cached(file("blob", "X"))).toBe(111);
  });

  it("rejects inspecting temporary references like Next.js", async () => {
    class Input {
      #secret: string;
      constructor(secret: string) {
        this.#secret = secret;
      }
      get secret() {
        return this.#secret;
      }
    }
    const fn = vi.fn(async (value: Input) => value.secret);
    const cached = registerCachedFunction(fn, "test:class");
    await expect(cached(new Input("first"))).rejects.toThrow("Cannot access secret");
    await expect(cached(new Input("second"))).rejects.toThrow("Cannot access secret");
  });

  it("keeps nested params, shared references, and cycles intact while keying maps", async () => {
    const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
    const cached = registerCachedFunction(fn, "test:map-params");
    const input = (slug: string) => {
      const params = Object.assign(Promise.resolve({ slug }), { slug });
      const map = new Map<unknown, unknown>([[params, { params }]]);
      map.set("self", map);
      return map;
    };
    const first = await cached(input("private"));
    expect(await cached(input("public"))).not.toBe(first);
    expect(await cached(input("private"))).toBe(first);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each(["file", "blob"])("persists replay arguments for %s inputs", async (kind) => {
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const encodeInvocationArgs = vi.fn(async () => "encrypted");
    const fn = vi.fn(async (_value: unknown) => "result");
    const cached = registerCachedFunction(fn, "test:replay-file", "", {
      serverReferenceId: "test#replay-file",
      encodeInvocationArgs,
    });
    const input = kind === "file" ? file() : new Blob(["hello"]);
    await cached({ input });
    await cached({ input });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    const invocation = set.mock.calls[0]?.[2]?.cacheFunctionInvocation;
    expect(encodeInvocationArgs).toHaveBeenCalledTimes(1);
    expect(invocation).toMatchObject({ encryptedArgs: "encrypted" });
  });

  it.each(["strings", "files", "nested"])(
    "uses Flight multipart ordering for %s arguments",
    async (kind) => {
      const fn = vi.fn(async (_value: unknown) => crypto.randomUUID());
      const cached = registerCachedFunction(fn, "test:promise-order");
      async function call(reverse: boolean) {
        const resolvers: (() => void)[] = [];
        const args = ["a", "b"].map(
          (name) =>
            new Promise((resolve) => {
              resolvers.push(() =>
                resolve(
                  kind === "strings"
                    ? name
                    : kind === "files"
                      ? file(name)
                      : { nested: Promise.resolve(new Map([[name, file(name)]])) },
                ),
              );
            }),
        );
        const result = cached(args);
        for (const index of reverse ? [1, 0] : [0, 1]) {
          resolvers[index]!();
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return result;
      }
      const first = await call(false);
      const reverse = await call(true);
      expect(reverse).not.toBe(first);
      expect(await call(false)).toBe(first);
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );

  it("distinguishes equal-size File contents", async () => {
    const fn = vi.fn(async (input: File) => input.text());
    const cached = registerCachedFunction(fn, "test:file-same-size");
    expect(await cached(file("same.txt", "A"))).toBe("A");
    expect(await cached(file("same.txt", "B"))).toBe("B");
    expect(await cached(file("same.txt", "A"))).toBe("A");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keys and executes arrays by index rather than their custom iterator", async () => {
    const fn = vi.fn(async (input: string[]) => input[0]);
    const cached = registerCachedFunction(fn, "test:array-iterator");
    const input = ["private"];
    Object.defineProperty(input, Symbol.iterator, {
      value: function* () {
        yield "public";
      },
    });
    expect(await cached(input)).toBe("private");
    expect(await cached(["public"])).toBe("public");
    expect(await cached(["private"])).toBe("private");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keys resolved files and drops promise decorations like Next.js", async () => {
    const fn = vi.fn(async (input: Promise<File> & { label: string }) => ({
      name: (await input).name,
      label: input.label,
    }));
    const cached = registerCachedFunction(fn, "test:augmented-promise");
    const input = (name: string, label = "same") =>
      Object.assign(Promise.resolve(file(name)), { label });
    expect(await cached(input("private"))).toEqual({ name: "private", label: undefined });
    expect(await cached(input("public"))).toEqual({ name: "public", label: undefined });
    expect(await cached(input("private", "different"))).toEqual({
      name: "private",
      label: undefined,
    });
    await cached(input("private"));
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("includes reserved params names exposed only by awaiting params", async () => {
    const fn = vi.fn(
      async (params: Promise<{ slug: string; value: string }>) => (await params).value,
    );
    const cached = registerCachedFunction(fn, "test:reserved-params");
    expect(await cached(makeThenableParams({ slug: "same", value: "private" }))).toBe("private");
    expect(await cached(makeThenableParams({ slug: "same", value: "public" }))).toBe("public");
    expect(await cached(makeThenableParams({ slug: "same", value: "private" }))).toBe("private");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps user status/value fields separate from the key transport promise", async () => {
    const fn = vi.fn(async (input: Promise<File>) => (await input).name);
    const cached = registerCachedFunction(fn, "test:promise-status");
    const input = (name: string) =>
      Object.assign(Promise.resolve(file(name)), { status: "fulfilled", value: "same" });
    expect(await cached(input("private"))).toBe("private");
    expect(await cached(input("public"))).toBe("public");
    expect(await cached(input("private"))).toBe("private");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("normalizes Date aliases and invalid Dates to Flight's decoded values", async () => {
    const fn = vi.fn(async (input: { first: Date; second: Date } | Date | null) => {
      if (input === null) return "null";
      if (input instanceof Date) return "date";
      return input.first === input.second;
    });
    const cached = registerCachedFunction(fn, "test:date-shape");
    const date = new Date(0);
    expect(await cached({ first: date, second: date })).toBe(false);
    expect(await cached({ first: new Date(0), second: new Date(0) })).toBe(false);
    expect(await cached(new Date(NaN))).toBe("null");
    expect(await cached(null)).toBe("null");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("executes the toJSON representation that Flight keys", async () => {
    const fn = vi.fn(async (input: { secret: string }) => input.secret);
    const cached = registerCachedFunction(fn, "test:to-json");
    const input = (secret: string) => ({ secret, toJSON: () => ({ public: "same" }) });
    expect(await cached(input("private"))).toBeUndefined();
    expect(await cached(input("public"))).toBeUndefined();
    expect(await cached(input("private"))).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("executes custom thenables through Flight's decoded promise", async () => {
    const fn = vi.fn(async (input: PromiseLike<Uint8Array>) => (await input).byteOffset);
    const cached = registerCachedFunction(fn, "test:own-then");
    const input = (view: Uint8Array) =>
      ({
        // eslint-disable-next-line unicorn/no-thenable
        then: (callback: (value: Uint8Array) => unknown) => callback(view),
      }) as PromiseLike<Uint8Array>;
    expect(await cached(input(new Uint8Array([99, 1]).subarray(1)))).toBe(0);
    expect(await cached(input(new Uint8Array([1])))).toBe(0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a promise's key envelope from a user supplied array", async () => {
    const fn = vi.fn(async (input: Promise<unknown> | unknown[]) => ({
      isPromise: input instanceof Promise,
      value: await input,
    }));
    const cached = registerCachedFunction(fn, "test:promise-envelope");
    expect(await cached(Promise.resolve("value"))).toEqual({ isPromise: true, value: "value" });
    expect(await cached(Promise.resolve(["value", {}]))).toEqual({
      isPromise: true,
      value: ["value", {}],
    });
    expect(await cached(["value", {}])).toEqual({ isPromise: false, value: ["value", {}] });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each([
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
  ])("normalizes %s view offsets and backing buffers before execution", async (Type) => {
    const fn = vi.fn(async (input: InstanceType<typeof Type>) => ({
      offset: input.byteOffset,
      bytes: [...new Uint8Array(input.buffer)],
      type: input.constructor.name,
    }));
    const cached = registerCachedFunction(fn, `test:view:${Type.name}`);
    const backing = new Type([99, 1]);
    const view = backing.subarray(1);
    const standalone = new Type([1]);
    const first = await cached(view);
    expect(first).toEqual({
      offset: 0,
      bytes: [...new Uint8Array(standalone.buffer)],
      type: Type.name,
    });
    expect(await cached(standalone)).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(view.byteOffset).toBe(Type.BYTES_PER_ELEMENT);
    expect(backing[0]).toBe(99);
  });

  it.each([BigInt64Array, BigUint64Array])("normalizes %s views", async (Type) => {
    const fn = vi.fn(async (input: BigInt64Array | BigUint64Array) => ({
      offset: input.byteOffset,
      bytes: [...new Uint8Array(input.buffer)],
    }));
    const cached = registerCachedFunction(fn, `test:view:${Type.name}`);
    const first = await cached(new Type([99n, 1n]).subarray(1));
    expect(first).toEqual({ offset: 0, bytes: [...new Uint8Array(new Type([1n]).buffer)] });
    expect(await cached(new Type([1n]))).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("normalizes DataView to its Flight representation", async () => {
    const fn = vi.fn(async (input: DataView) => ({
      offset: input.byteOffset,
      bytes: [...new Uint8Array(input.buffer)],
    }));
    const cached = registerCachedFunction(fn, "test:data-view");
    expect(await cached(new DataView(new Uint8Array([99, 1]).buffer, 1))).toEqual({
      offset: 0,
      bytes: [1],
    });
    expect(await cached(new DataView(new Uint8Array([1]).buffer))).toEqual({
      offset: 0,
      bytes: [1],
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses Buffer's native toJSON representation like Next.js", async () => {
    const fn = vi.fn(async (value: unknown) => value);
    const cached = registerCachedFunction(fn, "test:buffer");
    expect(await cached(Buffer.from([99, 1]).subarray(1))).toEqual({ type: "Buffer", data: [1] });
    expect(await cached(Buffer.from([1]))).toEqual({ type: "Buffer", data: [1] });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses Flight semantics for views, promise fields and cyclic collections", async () => {
    const fn = vi.fn(
      async (input: {
        params: Promise<{ view: Uint8Array }> & { view: Uint8Array };
        map: Map<unknown, unknown>;
      }) => {
        const resolved = await input.params;
        return {
          offset: resolved.view.byteOffset,
          bytes: [...new Uint8Array(resolved.view.buffer)],
          aliases: input.map.get(resolved.view) === input.params,
          cycle: input.map.get("self") === input.map,
        };
      },
    );
    const cached = registerCachedFunction(fn, "test:nested-views");
    const input = (view: Uint8Array) => {
      const params = Object.assign(Promise.resolve({ view }), { view });
      const map = new Map<unknown, unknown>([[view, params]]);
      map.set("self", map);
      return { params, map };
    };
    const first = await cached(input(new Uint8Array([99, 1]).subarray(1)));
    expect(first).toEqual({ offset: 0, bytes: [1], aliases: true, cycle: false });
    expect(await cached(input(new Uint8Array([1])))).toEqual(first);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("binary cache key framing", () => {
  it("distinguishes delimiter-containing strings from multiple entries", async () => {
    const first = new CacheFlightFormData();
    first.append("a", "x\0b=s:y");
    const second = new CacheFlightFormData();
    second.append("a", "x");
    second.append("b", "y");
    expect(await replyToCacheKey(first)).not.toBe(await replyToCacheKey(second));
  });

  it.each([false, true])(
    "preserves observable FormData ordering (duplicate names: %s)",
    async (duplicate) => {
      const first = new CacheFlightFormData();
      first.append("a", "1");
      first.append(duplicate ? "a" : "b", "2");
      const second = new CacheFlightFormData();
      second.append(duplicate ? "a" : "b", "2");
      second.append("a", "1");
      expect(await replyToCacheKey(first)).not.toBe(await replyToCacheKey(second));
    },
  );
});
