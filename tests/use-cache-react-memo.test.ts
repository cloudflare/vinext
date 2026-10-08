import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createElement } from "react";
import { createFromReadableStream, renderToReadableStream } from "@vitejs/plugin-rsc/react/rsc";
import {
  MemoryCacheHandler,
  setCacheHandler,
  unstable_cache,
} from "../packages/vinext/src/shims/cache.js";
import {
  registerCachedFunction,
  runWithPrivateCache,
} from "../packages/vinext/src/shims/cache-runtime.js";
import {
  encryptCacheCaptures,
  registerCachedFunction as registerCallableCachedFunction,
} from "../packages/vinext/src/shims/cache-callable-runtime.js";
import { workUnitAsyncStorage } from "../packages/vinext/src/shims/internal/work-unit-async-storage.js";

const environment = vi.hoisted(() => ({
  asyncLocalStorage: Object.getOwnPropertyDescriptor(globalThis, "AsyncLocalStorage"),
}));

vi.mock("@vitejs/plugin-rsc/utils/encryption-runtime", () => ({
  async encryptActionBoundArgs(value: string) {
    return value;
  },
  async decryptActionBoundArgs(value: Promise<string>) {
    return await value;
  },
}));

vi.mock("react", async () => {
  const { createRequire } = await import("node:module");
  const path = await import("node:path");
  const require = createRequire(import.meta.url);
  // Match the React instance loaded by the actual server codec in the helper.
  const reactServer = require(
    path.join(path.dirname(require.resolve("react/package.json")), "react.react-server.js"),
  );
  return { ...reactServer, default: reactServer };
});

describe("use cache React memoization scope boundaries", () => {
  beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

  it.each(["public", "unstable"])(
    "does not reuse a private result inside %s cache",
    async (kind) => {
      const privateFn = registerCachedFunction(
        async (value: number) => ({ value }),
        `scope:${kind}`,
        "private",
      );
      const nested =
        kind === "public"
          ? registerCachedFunction(async (value: number) => privateFn(value), "scope:public")
          : unstable_cache(async (value: number) => privateFn(value), ["scope:unstable"]);

      expect(
        await renderProbe(async () => {
          await privateFn(1);
          try {
            await nested(1);
            return "unexpected success";
          } catch (error) {
            return (error as Error).message;
          }
        }),
      ).toContain(
        kind === "public"
          ? 'must not be used within "use cache"'
          : "must not be used within `unstable_cache()`",
      );
    },
  );

  it.each(["parent cache", "work unit"])(
    "memoizes capture envelopes only within the same %s scope",
    async (kind) => {
      let reads = 0;
      const input = {
        get value() {
          reads++;
          return 1;
        },
      };
      const observed: {
        envelope: ReturnType<typeof encryptCacheCaptures>;
        same: boolean;
        reads: number;
      }[] = [];
      const record = async () => {
        const envelope = encryptCacheCaptures([input]);
        const repeated = encryptCacheCaptures([input]);
        await envelope.encrypted;
        observed.push({ envelope, same: envelope === repeated, reads });
        return null;
      };
      const parent = registerCachedFunction(
        async (_partition: string) => record(),
        `scope:captures:${kind}`,
      );

      expect(
        await renderProbe(async () => {
          if (kind === "parent cache") {
            await parent("first");
            await parent("second");
          } else {
            await workUnitAsyncStorage.run({ type: "request" }, record);
            await workUnitAsyncStorage.run({ type: "request" }, record);
          }
          const [first, second] = observed;
          return {
            firstMemoized: first!.same,
            secondMemoized: second!.same,
            separate: first!.envelope !== second!.envelope,
            serializedAgain: second!.reads > first!.reads,
          };
        }),
      ).toEqual({
        firstMemoized: true,
        secondMemoized: true,
        separate: true,
        serializedAgain: true,
      });
    },
  );
});

vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  // plugin-rsc injects this before loading its edge server codec. React.cache
  // needs the renderer's request storage to survive awaits in a Server Component.
  Reflect.set(globalThis, "AsyncLocalStorage", AsyncLocalStorage);
  const { loadCacheFlightCodec } = await import("./helpers/cache-flight-codec.js");
  return loadCacheFlightCodec("development");
});

afterAll(() => {
  if (environment.asyncLocalStorage) {
    Object.defineProperty(globalThis, "AsyncLocalStorage", environment.asyncLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "AsyncLocalStorage");
  }
});

async function renderProbe(probe: () => Promise<unknown>): Promise<unknown> {
  async function Probe() {
    return JSON.stringify(await runWithPrivateCache(probe));
  }
  const json = await createFromReadableStream<string>(renderToReadableStream(createElement(Probe)));
  return JSON.parse(json);
}

// Next.js wraps every cache kind in React.cache, and its referential-equality
// fixture checks the same result identity inside a Server Component render:
// https://github.com/vercel/next.js/blob/v16.3.7/crates/next-custom-transforms/src/transforms/server_actions.rs#L2984
// https://github.com/vercel/next.js/blob/v16.3.7/test/e2e/app-dir/use-cache/app/(partially-static)/referential-equality/page.tsx
describe.each(["", "private"])("use cache React render memoization (%s)", (variant) => {
  beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

  it("returns the same result object for the same primitive argument", async () => {
    const cached = registerCachedFunction(
      async (value: number) => ({ value }),
      `test:react-memo:primitive:${variant}`,
      variant,
    );

    expect(
      await renderProbe(async () => {
        const first = await cached(1);
        const second = await cached(1);
        return { same: first === second, value: second.value };
      }),
    ).toEqual({ same: true, value: 1 });
  });

  it("returns the same result object for the same object argument", async () => {
    const cached = registerCachedFunction(
      async (input: { value: number }) => ({ value: input.value }),
      `test:react-memo:object:${variant}`,
      variant,
    );
    const input = { value: 1 };

    expect(
      await renderProbe(async () => {
        const first = await cached(input);
        const second = await cached(input);
        return { same: first === second, value: second.value };
      }),
    ).toEqual({ same: true, value: 1 });
  });

  it("rebinds temporary references when the original object argument changes", async () => {
    class Input {}
    const firstInput = new Input();
    const secondInput = new Input();
    const fn = vi.fn(async (value: Input) => ({ value }));
    const cached = registerCachedFunction(fn, `test:react-memo:opaque:${variant}`, variant);

    expect(
      await renderProbe(async () => {
        const first = await cached(firstInput);
        const second = await cached(secondInput);
        const repeated = await cached(firstInput);
        return {
          first: first.value === firstInput,
          second: second.value === secondInput,
          separate: first !== second,
          repeated: repeated === first,
        };
      }),
    ).toEqual({ first: true, second: true, separate: true, repeated: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(["primitive", "object"])(
    "returns the same result for repeated identical %s captures",
    async (kind) => {
      const cached = registerCallableCachedFunction(
        async (captures: unknown) => ({ value: (captures as unknown[])[0] }),
        `test:react-memo:captures:${kind}:${variant}`,
        variant,
        {},
      );
      const value = kind === "primitive" ? 1 : { label: "same" };

      expect(
        await renderProbe(async () => {
          const envelope = encryptCacheCaptures([value]);
          const first = await cached(envelope);
          const sameEnvelope = await cached(envelope);
          // Inline cache transforms allocate a fresh captures array and call
          // encryptCacheCaptures again every time the containing function runs.
          const sameCaptures = await cached(encryptCacheCaptures([value]));
          return {
            sameEnvelope: first === sameEnvelope,
            sameCaptures: first === sameCaptures,
          };
        }),
      ).toEqual({ sameEnvelope: true, sameCaptures: true });
    },
  );
});
