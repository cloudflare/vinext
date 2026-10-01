import type { VinextCacheFunctionInvocation } from "../packages/vinext/src/server/multi-stage.js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { APP_PAGE_USE_CACHE_MARKER } from "../packages/vinext/src/shims/internal/app-page-props-cache-key.js";
import {
  encodeCacheArguments,
  decodeCacheArguments,
  encryptCacheCaptures,
  registerCachedFunction,
  invokeCacheFunction,
} from "../packages/vinext/src/shims/cache-callable-runtime.js";

const encryption = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@vitejs/plugin-rsc/utils/encryption-runtime", () => ({
  async encryptActionBoundArgs(value: unknown) {
    const id = `encrypted:${encryption.values.size}`;
    encryption.values.set(id, value);
    return id;
  },
  async decryptActionBoundArgs(id: Promise<string>) {
    return encryption.values.get(await id);
  },
}));
vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { loadCacheFlightCodec } = await import("./helpers/cache-flight-codec.js");
  return loadCacheFlightCodec();
});

beforeEach(() => {
  encryption.values.clear();
  setCacheHandler(new MemoryCacheHandler());
});
const file = () => new File(["private"], "private.txt", { type: "text/plain", lastModified: 111 });

// Argument decoding is React's implementation, as in Next.js use-cache-wrapper.ts.
// Only the ordered multipart transport and native File metadata are ours.
describe("cache callable Flight transport", () => {
  it.each(["async component", "promise"])("captures JSX from an %s", async (kind) => {
    const { createElement } = await import("react");
    async function CapturedChild() {
      await Promise.resolve();
      return createElement("p", null, "lazy captured child");
    }
    const child =
      kind === "async component"
        ? createElement(CapturedChild)
        : Promise.resolve(createElement("p", null, "lazy captured child"));
    const cached = registerCachedFunction(
      async (captures: unknown) => ({ child: await (captures as unknown[])[0] }),
      `test:lazy-capture:${kind}`,
      "",
      {},
    );

    expect(await cached(encryptCacheCaptures([child]))).toMatchObject({
      child: { type: "p", props: { children: "lazy captured child" } },
    });
  });

  it("captures JSX and global symbols alongside Files without rereading getters", async () => {
    const { createElement } = await import("react");
    const node = createElement("p", null, "captured child");
    const symbol = Symbol.for("test:captured-symbol");
    let reads = 0;
    const cached = registerCachedFunction(
      async (value: unknown) => {
        const [child, token, input] = value as [unknown, unknown, { file: File }];
        return {
          child,
          token,
          name: input.file.name,
          time: input.file.lastModified,
          text: await input.file.text(),
        };
      },
      "test:rich-captures",
      "",
      { serverReferenceId: "test#rich-captures" },
    );
    const result = await cached(
      encryptCacheCaptures([
        node,
        symbol,
        {
          get file() {
            reads++;
            return file();
          },
        },
      ]),
    );
    expect(result).toMatchObject({
      child: { type: "p", props: { children: "captured child" } },
      token: symbol,
      name: "private.txt",
      time: 111,
      text: "private",
    });
    expect(reads).toBe(1);
  });
  it("preserves File metadata and represented references through JSON persistence", async () => {
    const original = file();
    const form = new FormData();
    form.append("file", original);
    form.append("file", original);
    const encoded = await encodeCacheArguments([
      original,
      { file: original },
      Promise.resolve(original),
      new Map([["file", original]]),
      new Set([original]),
      form,
    ]);
    const decoded = await decodeCacheArguments(JSON.parse(JSON.stringify(encoded)));
    const restored = decoded[0] as File;
    expect([restored.name, restored.lastModified, restored.type, await restored.text()]).toEqual([
      "private.txt",
      111,
      "text/plain",
      "private",
    ]);
    expect((decoded[1] as { file: File }).file).toBe(restored);
    expect(await decoded[2]).toBe(restored);
    expect((decoded[3] as Map<string, File>).get("file")).toBe(restored);
    expect((decoded[4] as Set<File>).has(restored)).toBe(true);
    const entries = [...(decoded[5] as FormData).values()] as File[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).not.toBe(restored);
    expect(entries[0]).not.toBe(entries[1]);
    expect(await entries[0]!.text()).toBe("private");
    expect(entries[0]!.lastModified).toBe(111);
  });

  it.each([false, true])(
    "replays the exact payload without reading a getter again (file: %s)",
    async (binary) => {
      const handler = new MemoryCacheHandler();
      const get = vi.spyOn(handler, "get");
      const set = vi.spyOn(handler, "set");
      setCacheHandler(handler);
      let reads = 0;
      let executions = 0;
      const cached = registerCachedFunction(
        async (arg: { value: string | File }) => ({
          execution: ++executions,
          value: typeof arg.value === "string" ? arg.value : await arg.value.text(),
        }),
        "test:getter-replay",
        "",
        { serverReferenceId: "test#getter-replay" },
      );
      const first = await cached({
        get value() {
          reads++;
          return binary ? file() : "private";
        },
      });
      expect(first).toEqual({ execution: 1, value: "private" });
      expect(reads).toBe(1);
      const invocation = set.mock.calls[0]![2]!
        .cacheFunctionInvocation as VinextCacheFunctionInvocation;
      get.mockResolvedValueOnce(null);
      await invokeCacheFunction(invocation, async () => cached);
      expect(reads).toBe(1);
      expect(executions).toBe(2);
      expect(get.mock.calls[1]![0]).toBe(get.mock.calls[0]![0]);
      expect(set.mock.calls[1]![0]).toBe(set.mock.calls[0]![0]);
      expect(typeof encryption.values.get(invocation.encryptedArgs)).toBe("string");
    },
  );

  it("restores framework page params and the page marker on replay", async () => {
    const handler = new MemoryCacheHandler();
    const get = vi.spyOn(handler, "get");
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const observed: unknown[] = [];
    const cached = registerCachedFunction(
      async (props: {
        params: Promise<{ slug: string; value: string }> & { slug: string };
        [APP_PAGE_USE_CACHE_MARKER]?: boolean;
      }) => {
        observed.push([props.params.slug, await props.params]);
        return props.params.slug;
      },
      "test:page-replay",
      "",
      { serverReferenceId: "test#page-replay" },
    );
    await cached({
      params: makeThenableParams({ slug: "replayed", value: "reserved" }),
      [APP_PAGE_USE_CACHE_MARKER]: true,
    });
    const invocation = set.mock.calls[0]![2]!
      .cacheFunctionInvocation as VinextCacheFunctionInvocation;
    get.mockResolvedValueOnce(null);
    await invokeCacheFunction(invocation, async () => cached);
    expect(observed).toEqual([
      ["replayed", { slug: "replayed", value: "reserved" }],
      ["replayed", { slug: "replayed", value: "reserved" }],
    ]);
    expect(set.mock.calls[1]![0]).toBe(set.mock.calls[0]![0]);
  });

  it("retains captured File metadata and serializes getters once", async () => {
    let reads = 0;
    const cached = registerCachedFunction(
      async (value: unknown) => {
        const [captured] = value as [{ file: File }];
        return [captured!.file.name, captured!.file.lastModified, await captured!.file.text()];
      },
      "test:captures",
      "",
      { serverReferenceId: "test#captures" },
    );
    const result = await cached(
      encryptCacheCaptures([
        {
          get file() {
            reads++;
            return file();
          },
        },
      ]),
    );
    expect(result).toEqual(["private.txt", 111, "private"]);
    expect(reads).toBe(1);
  });

  it("uses React for iterables, nested promises, array holes and cycles", async () => {
    const object: { self?: unknown; value: string } = { value: "same" };
    object.self = object;
    const inherited = Object.assign(Object.create(Array.prototype), { 1: "inherited" });
    // A true hole is required to exercise inherited indexed properties.
    // eslint-disable-next-line unicorn/no-new-array
    const sparse = new Array(2);
    Object.setPrototypeOf(sparse, inherited);
    const [record, iterable, promise, array] = await decodeCacheArguments(
      await encodeCacheArguments([
        object,
        {
          *[Symbol.iterator]() {
            yield 1;
            yield 2;
          },
        },
        Promise.resolve(Promise.resolve("resolved")),
        sparse,
      ]),
    );
    expect((record as typeof object).self).toBe(record);
    expect(iterable).toEqual([1, 2]);
    expect(await promise).toBe("resolved");
    expect(array).toEqual([undefined, "inherited"]);
  });

  it("rejects old invocation envelopes", async () => {
    await expect(decodeCacheArguments({ args: [] } as never)).rejects.toThrow(
      "Invalid cache function arguments",
    );
  });
});
