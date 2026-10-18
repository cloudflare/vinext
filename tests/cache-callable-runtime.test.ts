import type { VinextCacheFunctionInvocation } from "../packages/vinext/src/server/multi-stage.js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import { APP_PAGE_USE_CACHE_MARKER } from "../packages/vinext/src/shims/internal/app-page-props-cache-key.js";
import {
  encryptCacheCaptures,
  registerCachedFunction,
  invokeCacheFunction,
} from "../packages/vinext/src/shims/cache-callable-runtime.js";
import {
  restoreFlightReply,
  snapshotFlightReply,
} from "../packages/vinext/src/shims/cache-flight-arguments.js";
import { decodeReply, encodeReply } from "@vitejs/plugin-rsc/react/rsc";

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
beforeEach(() => {
  encryption.values.clear();
  setCacheHandler(new MemoryCacheHandler());
});
const file = () => new File(["private"], "private.txt", { type: "text/plain", lastModified: 111 });
// The persisted argument transport, as cache-runtime.ts encodes and replays it.
async function roundTripArguments(args: unknown[]): Promise<unknown[]> {
  const persisted = JSON.parse(JSON.stringify(await snapshotFlightReply(await encodeReply(args))));
  return (await decodeReply(restoreFlightReply(persisted))) as unknown[];
}

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
      { captureCount: 1, serverReferenceId: `test#lazy-capture:${kind}` },
    );

    expect(await cached(encryptCacheCaptures(`test#lazy-capture:${kind}`, [child]))).toMatchObject({
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
      { captureCount: 3, serverReferenceId: "test#rich-captures" },
    );
    const result = await cached(
      encryptCacheCaptures("test#rich-captures", [
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
    const decoded = await roundTripArguments([
      original,
      { file: original },
      Promise.resolve(original),
      new Map([["file", original]]),
      new Set([original]),
      form,
    ]);
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
      { captureCount: 1, serverReferenceId: "test#captures" },
    );
    const result = await cached(
      encryptCacheCaptures("test#captures", [
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

  // Like Next.js (use-cache-wrapper.ts, `boundArgsLength`), a capturing function
  // decrypts its first argument or fails. A client must not choose its captures.
  it.each([
    ["plaintext captures", [["victim"]]],
    ["missing captures", []],
    ["a malformed envelope", [{ type: "use-cache-captures", encrypted: 1 }]],
    ["an envelope-shaped value", [{ type: "use-cache-captures", encrypted: "unknown" }]],
  ])("rejects %s for a capturing function", async (_kind, args) => {
    const fn = vi.fn(async (captures: unknown) => (captures as unknown[])[0]);
    const cached = registerCachedFunction(fn, "test:forged-captures", "", {
      captureCount: 1,
      serverReferenceId: "test#forged-captures",
    }) as (...args: unknown[]) => Promise<unknown>;

    await expect(cached(...args)).rejects.toThrow(/Invalid cache capture arguments/);
    expect(fn).not.toHaveBeenCalled();
  });

  // Like Next.js binding encrypted bound args to their action id, captures
  // obtained from another function (e.g. a public page) cannot be replayed.
  it("rejects captures encrypted for another function", async () => {
    const fn = vi.fn(async (captures: unknown) => (captures as unknown[])[0]);
    const cached = registerCachedFunction(fn, "test:tenant", "", {
      captureCount: 1,
      serverReferenceId: "test#tenant",
    });
    const other = encryptCacheCaptures("test#public-label", ["victim"]);
    // A client sends the envelope's encrypted string, not the pending promise.
    const replayed = { type: other.type, encrypted: await other.encrypted };

    await expect(cached(replayed)).rejects.toThrow(/Invalid cache capture arguments/);
    expect(fn).not.toHaveBeenCalled();
    await expect(cached(encryptCacheCaptures("test#tenant", ["acme"]))).resolves.toBe("acme");
  });

  // During dev, an edited closure keeps its reference: an envelope minted
  // before the edit must not run it with missing or extra captures.
  it.each([
    ["too few", ["acme"]],
    ["too many", ["acme", "eu", "extra"]],
  ])("rejects %s captures for the same reference", async (_kind, captures) => {
    const fn = vi.fn(async (value: unknown) => value);
    const cached = registerCachedFunction(fn, "test:capture-count", "", {
      captureCount: 2,
      serverReferenceId: "test#capture-count",
    });

    await expect(cached(encryptCacheCaptures("test#capture-count", captures))).rejects.toThrow(
      /Invalid cache capture arguments/,
    );
    expect(fn).not.toHaveBeenCalled();
    await expect(
      cached(encryptCacheCaptures("test#capture-count", ["acme", "eu"])),
    ).resolves.toEqual(["acme", "eu"]);
  });

  it("never decrypts the first argument of a function without captures", async () => {
    const value = { type: "use-cache-captures", encrypted: "plain-data" };
    const cached = registerCachedFunction(async (arg: unknown) => arg, "test:no-captures", "", {
      serverReferenceId: "test#no-captures",
    });

    await expect(cached(value)).resolves.toEqual(value);
  });

  it("uses React for iterables, nested promises, array holes and cycles", async () => {
    const object: { self?: unknown; value: string } = { value: "same" };
    object.self = object;
    const inherited = Object.assign(Object.create(Array.prototype), { 1: "inherited" });
    // A true hole is required to exercise inherited indexed properties.
    // eslint-disable-next-line unicorn/no-new-array
    const sparse = new Array(2);
    Object.setPrototypeOf(sparse, inherited);
    const [record, iterable, promise, array] = await roundTripArguments([
      object,
      {
        *[Symbol.iterator]() {
          yield 1;
          yield 2;
        },
      },
      Promise.resolve(Promise.resolve("resolved")),
      sparse,
    ]);
    expect((record as typeof object).self).toBe(record);
    expect(iterable).toEqual([1, 2]);
    expect(await promise).toBe("resolved");
    expect(array).toEqual([undefined, "inherited"]);
  });

  it("rejects old invocation envelopes", async () => {
    encryption.values.set("old", JSON.stringify({ args: [] }));
    const fn = vi.fn(async () => "value");
    const cached = registerCachedFunction(fn, "test:old-envelope", "", {});
    await expect(
      invokeCacheFunction(
        { encryptedArgs: "old", referenceId: "test#old-envelope" } as VinextCacheFunctionInvocation,
        async () => cached,
      ),
    ).rejects.toThrow("Invalid cache function arguments");
    expect(fn).not.toHaveBeenCalled();
  });
});
