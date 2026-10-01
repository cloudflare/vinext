import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { MemoryCacheHandler, setCacheHandler } from "../packages/vinext/src/shims/cache.js";
import {
  registerCachedFunction,
  replayCachedFunction,
} from "../packages/vinext/src/shims/cache-runtime.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";
import {
  withUseCacheLayoutMarker,
  withUseCachePageMarker,
} from "../packages/vinext/src/shims/internal/app-page-props-cache-key.js";
import {
  resolveModuleMetadata,
  resolveModuleViewport,
} from "../packages/vinext/src/shims/metadata.js";
import type { CacheFlightArguments } from "../packages/vinext/src/shims/cache-flight-arguments.js";
import { probeAppPageLayoutWithTracking } from "../packages/vinext/src/server/app-page-route-wiring.js";
import {
  createPprFallbackShellState,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";

vi.mock("@vitejs/plugin-rsc/react/rsc", async () => {
  const { loadCacheFlightCodec } = await import("./helpers/cache-flight-codec.js");
  return loadCacheFlightCodec();
});

beforeEach(() => setCacheHandler(new MemoryCacheHandler()));

// Next.js restores framework segment params separately from ordinary arguments:
// https://github.com/vercel/next.js/blob/canary/packages/next/src/server/use-cache/use-cache-wrapper.ts
// See isPageSegmentFunction/isLayoutSegmentFunction and their outerParams wrappers.
describe("use cache framework props", () => {
  // Only the framework's layout invocation can opt into params restoration.
  // Next's segment handling is described in use-cache-wrapper.ts above; an
  // ordinary argument must retain its Flight-encoded fields and cache key.
  it("preserves an ordinary true-valued $$isLayout field without adding params", async () => {
    const fn = vi.fn(async (props: Record<string, unknown>) => ({
      props,
      hasParams: Object.hasOwn(props, "params"),
    }));
    const cached = registerCachedFunction(fn, "ordinary-layout-field");
    const input = { $$isLayout: true, value: "ordinary" };
    expect(await cached(input)).toEqual({ props: input, hasParams: false });
    expect(await cached({ ...input })).toEqual({ props: input, hasParams: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keys ordinary true-valued $$isLayout fields separately from absent fields", async () => {
    const fn = vi.fn(async (props: Record<string, unknown>) => props);
    const cached = registerCachedFunction(fn, "ordinary-layout-field-key");
    await cached({ value: "ordinary" });
    await cached({ value: "ordinary", $$isLayout: true });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(await cached({ value: "ordinary", $$isLayout: true })).toEqual({
      value: "ordinary",
      $$isLayout: true,
    });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("replays ordinary true-valued $$isLayout fields without framework metadata", async () => {
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const payloads: CacheFlightArguments[] = [];
    const fn = vi.fn(async (props: Record<string, unknown>) => ({ ...props }));
    const cached = registerCachedFunction(fn, "ordinary-layout-field-replay", "", {
      serverReferenceId: "ordinary-layout-field-replay",
      encodeInvocation: async (args) => {
        payloads.push(args);
        return "encrypted";
      },
    });
    const input = { $$isLayout: true, value: "ordinary" };
    await cached(input);
    expect(payloads[0]?.layoutPropsIndex).toBeUndefined();
    expect(payloads[0]?.pagePropsIndex).toBeUndefined();
    const replayHandler = new MemoryCacheHandler();
    const replaySet = vi.spyOn(replayHandler, "set");
    setCacheHandler(replayHandler);
    expect(await replayCachedFunction(cached, payloads[0]!)).toEqual(input);
    expect(replaySet.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
    expect(await cached({ ...input })).toEqual(input);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(input);
  });

  // Parallel route slots are layout props. Next preserves outerSlots after
  // removing its layout marker, but currently overwrites a $$isLayout slot:
  // https://github.com/vercel/next.js/blob/v16.3.7/packages/next/src/server/app-render/create-component-tree.tsx#L1046
  // Keep both names supported by vinext's route scanner without losing data.
  it.each(["$$isLayout", "$$isPage"])(
    "keeps the %s slot in execution, cache keys, and replay",
    async (slotName) => {
      const handler = new MemoryCacheHandler();
      const set = vi.spyOn(handler, "set");
      setCacheHandler(handler);
      const payloads: CacheFlightArguments[] = [];
      const fn = vi.fn(async (props: Record<string, unknown>) => ({
        slot: props[slotName],
        keys: Object.keys(props).sort(),
      }));
      const cached = registerCachedFunction(fn, `marker-slot:${slotName}`, "", {
        argumentCount: 1,
        serverReferenceId: `marker-slot:${slotName}`,
        encodeInvocation: async (args) => {
          payloads.push(args);
          return "encrypted";
        },
      });
      const call = (value: string | boolean) => {
        // React copies enumerable props before the cached component runs.
        const element = createElement(
          "div",
          withUseCacheLayoutMarker(cached, {
            params: makeThenableParams({}),
            [slotName]: value,
          }),
        );
        return cached(element.props);
      };
      const expected = (slot: string | boolean) => ({ slot, keys: [slotName, "params"] });
      expect(await call("first")).toEqual(expected("first"));
      expect(await call("second")).toEqual(expected("second"));
      expect(await call("first")).toEqual(expected("first"));
      expect(fn).toHaveBeenCalledTimes(2);
      expect(set.mock.calls[0]?.[0]).not.toBe(set.mock.calls[1]?.[0]);

      const replayHandler = new MemoryCacheHandler();
      const replaySet = vi.spyOn(replayHandler, "set");
      setCacheHandler(replayHandler);
      expect(await replayCachedFunction(cached, payloads[0]!)).toEqual(expected("first"));
      expect(replaySet.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
      expect(await call("first")).toEqual(expected("first"));
      expect(fn).toHaveBeenCalledTimes(3);
      expect(await call(true)).toEqual(expected(true));
    },
  );

  it.each(["$$isLayout", "$$isPage"])(
    "rebinds the %s ReactNode slot on cache hits",
    async (slotName) => {
      const fn = vi.fn(async (props: Record<string, unknown>) => props[slotName]);
      const cached = registerCachedFunction(fn, `marker-node-slot:${slotName}`);
      const call = (slot: ReturnType<typeof createElement>) =>
        cached(
          withUseCacheLayoutMarker(cached, { params: makeThenableParams({}), [slotName]: slot }),
        );
      const first = createElement("p", null, "first slot");
      const second = createElement("p", null, "second slot");
      expect(await call(first)).toBe(first);
      expect(await call(second)).toBe(second);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps Flight semantics for absent, undefined, and null slots when marked repeatedly", async () => {
    const fn = vi.fn(async (props: Record<string, unknown>) => ({
      slot: props.$$isLayout,
      hasSlot: Object.hasOwn(props, "$$isLayout"),
    }));
    const cached = registerCachedFunction(fn, "repeated-layout-slot-marker");
    const ordinary = registerCachedFunction(
      async (props: Record<string, unknown>) => ({
        slot: props.sidebar,
        hasSlot: Object.hasOwn(props, "sidebar"),
      }),
      "ordinary-layout-slot-values",
    );
    for (const slot of [{}, { $$isLayout: undefined }, { $$isLayout: null }]) {
      const props = withUseCacheLayoutMarker(cached, { params: makeThenableParams({}), ...slot });
      // Flight preserves undefined in the key but removes the property when
      // decoding. Marker restoration must retain these ordinary semantics.
      const expected = await ordinary("$$isLayout" in slot ? { sidebar: slot.$$isLayout } : {});
      expect(await cached(withUseCacheLayoutMarker(cached, props))).toEqual(expected);
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not apply page semantics to a true-valued layout slot", async () => {
    const fn = vi.fn(async (props: Record<string, unknown>) => ({
      slot: props.$$isPage,
      searchParams: await props.searchParams,
    }));
    const cached = registerCachedFunction(fn, "layout-page-marker-and-search-slot");
    const call = (query: string) =>
      cached(
        withUseCacheLayoutMarker(cached, {
          params: makeThenableParams({}),
          $$isPage: true,
          searchParams: Promise.resolve({ query }),
        }),
      );
    expect(await call("first")).toEqual({ slot: true, searchParams: { query: "first" } });
    expect(await call("second")).toEqual({ slot: true, searchParams: { query: "second" } });
    expect(await call("first")).toEqual({ slot: true, searchParams: { query: "first" } });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // Next.js reinjects outerParams for cached segments so unused fallback keys
  // do not block them. Its params tests distinguish awaiting from key access:
  // https://github.com/vercel/next.js/blob/v16.3.7/packages/next/src/server/use-cache/use-cache-wrapper.ts#L2037
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/cache-components/cache-components.params.test.ts
  describe.each(["$$isPage", "$$isLayout"])("fallback params for %s", (marker) => {
    const markProps = marker === "$$isLayout" ? withUseCacheLayoutMarker : withUseCachePageMarker;
    it.each(["unused", "await-only", "known-key"])(
      "does not suspend when params are %s",
      async (access) => {
        const handler = new MemoryCacheHandler();
        const get = vi.spyOn(handler, "get");
        const set = vi.spyOn(handler, "set");
        setCacheHandler(handler);
        const observed: string[][] = [];
        const state = createPprFallbackShellState({
          fallbackParamNames: ["slug"],
          routePattern: "/:locale/:slug",
        });
        const cached = registerCachedFunction(
          async ({ params }: { params: Promise<{ locale: string; slug: string }> }) => {
            if (access === "unused") return "ready";
            const resolved = await params;
            return access === "known-key" ? resolved.locale : "ready";
          },
          `fallback:${marker}:${access}`,
          "",
          { argumentCount: 1 },
        );

        try {
          const result = runWithPprFallbackShellState(state, () =>
            cached(
              markProps(cached, {
                params: makeThenableParams(
                  { locale: "en", slug: "[slug]" },
                  { observeParamAccess: (keys) => observed.push([...keys]) },
                ),
              }),
            ),
          );
          await expect(result).resolves.toBe(access === "known-key" ? "en" : "ready");
          expect(state.hasDynamicBoundary).toBe(false);
          expect(observed).toEqual(access === "known-key" ? [["locale"]] : []);
          // Placeholder params are incomplete and must not read or populate a
          // concrete route's data entry, or persist an unguarded replay.
          expect(get).not.toHaveBeenCalled();
          expect(set).not.toHaveBeenCalled();
        } finally {
          state.abortController.abort();
        }
      },
    );

    it("does not reuse a concrete placeholder-named route for a fallback key read", async () => {
      const handler = new MemoryCacheHandler();
      const get = vi.spyOn(handler, "get");
      const set = vi.spyOn(handler, "set");
      setCacheHandler(handler);
      const fn = vi.fn(
        async ({ params }: { params: Promise<{ slug: string }> }) => (await params).slug,
      );
      const cached = registerCachedFunction(fn, `fallback-collision:${marker}`, "", {
        argumentCount: 1,
      });
      const props = () => markProps(cached, { params: makeThenableParams({ slug: "[slug]" }) });
      expect(await cached(props())).toBe("[slug]");
      expect(set).toHaveBeenCalledTimes(1);
      get.mockClear();
      set.mockClear();

      const state = createPprFallbackShellState({
        fallbackParamNames: ["slug"],
        routePattern: "/:slug",
      });
      try {
        const suspended = await runWithPprFallbackShellState(state, () =>
          cached(props()).then(
            () => false,
            (error: unknown) => error instanceof Promise,
          ),
        );
        expect(suspended).toBe(true);
        expect(state.hasDynamicBoundary).toBe(true);
        expect(fn).toHaveBeenCalledTimes(2);
        expect(get).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
      } finally {
        state.abortController.abort();
      }
    });

    it("keeps unbranded params consistent on warm and cold fallback-scope calls", async () => {
      const fn = vi.fn(
        async ({ params }: { params: Promise<{ slug: string }> }) => (await params).slug,
      );
      const cached = registerCachedFunction(fn, `unbranded-fallback:${marker}`);
      const props = () => markProps(cached, { params: Promise.resolve({ slug: "[slug]" }) });
      expect(await cached(props())).toBe("[slug]");

      const state = createPprFallbackShellState({
        fallbackParamNames: ["slug"],
        routePattern: "/:slug",
      });
      try {
        expect(await runWithPprFallbackShellState(state, () => cached(props()))).toBe("[slug]");
        expect(fn).toHaveBeenCalledTimes(1);

        setCacheHandler(new MemoryCacheHandler());
        expect(await runWithPprFallbackShellState(state, () => cached(props()))).toBe("[slug]");
        expect(fn).toHaveBeenCalledTimes(2);
        // Invocation markers alone do not confer the factory's fallback metadata.
        expect(state.hasDynamicBoundary).toBe(false);
      } finally {
        state.abortController.abort();
      }
    });
  });

  it.each(["$$isPage", "$$isLayout"])(
    "discards unused %s props before restoration",
    async (marker) => {
      const markProps = marker === "$$isLayout" ? withUseCacheLayoutMarker : withUseCachePageMarker;
      let payload: CacheFlightArguments | undefined;
      const fn = vi.fn(async () => "rendered");
      const cached = registerCachedFunction(fn, `no-args:${marker}`, "", {
        argumentCount: 0,
        serverReferenceId: `no-args:${marker}`,
        encodeInvocation: async (args) => {
          payload = args;
          return "encrypted";
        },
      });
      const call = (slug: string) =>
        Reflect.apply(cached, null, [
          markProps(cached, {
            params: makeThenableParams({ slug }),
            searchParams: Promise.resolve({ query: slug }),
          }),
        ]);
      expect(await call("first")).toBe("rendered");
      expect(await call("second")).toBe("rendered");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith();
      expect(payload?.pagePropsIndex).toBeUndefined();
      expect(payload?.layoutPropsIndex).toBeUndefined();
      setCacheHandler(new MemoryCacheHandler());
      expect(await replayCachedFunction(cached, payload!)).toBe("rendered");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenLastCalledWith();
    },
  );

  it("restores layout params, preserves slots, and replays the same key", async () => {
    const handler = new MemoryCacheHandler();
    const set = vi.spyOn(handler, "set");
    setCacheHandler(handler);
    const payloads: CacheFlightArguments[] = [];
    const fn = vi.fn(
      async (props: {
        params: ReturnType<typeof makeThenableParams<{ slug: string }>>;
        children: unknown;
        sidebar: string;
      }) => ({
        sync: props.params.slug,
        async: (await props.params).slug,
        children: props.children,
        sidebar: props.sidebar,
        keys: Object.keys(props),
      }),
    );
    const cached = registerCachedFunction(fn, "layout-props", "", {
      argumentCount: 1,
      serverReferenceId: "layout-props",
      encodeInvocation: async (args) => {
        payloads.push(args);
        return "encrypted";
      },
    });
    const child = createElement("p", null, "child");
    const call = (slug: string) =>
      cached(
        withUseCacheLayoutMarker(cached, {
          params: makeThenableParams({ slug }),
          children: child,
          sidebar: "slot",
        }),
      );
    expect(await call("first")).toEqual({
      sync: "first",
      async: "first",
      children: child,
      sidebar: "slot",
      keys: ["params", "children", "sidebar"],
    });
    expect((await call("second")).sync).toBe("second");
    expect((await call("first")).sync).toBe("first");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(payloads[0]?.layoutPropsIndex).toBe(0);
    expect(payloads[0]?.pagePropsIndex).toBeUndefined();
    const replayHandler = new MemoryCacheHandler();
    const replaySet = vi.spyOn(replayHandler, "set");
    setCacheHandler(replayHandler);
    await replayCachedFunction(cached, payloads[0]!);
    expect(replaySet.mock.calls[0]?.[0]).toBe(set.mock.calls[0]?.[0]);
    expect((await call("first")).sync).toBe("first");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each(["metadata", "viewport"])("marks layout %s invocations", async (kind) => {
    const fn = vi.fn(
      async ({ params }: { params: ReturnType<typeof makeThenableParams<{ slug: string }>> }) =>
        kind === "metadata" ? { title: params.slug } : { themeColor: params.slug },
    );
    const cached = registerCachedFunction(fn, `layout-${kind}`, "", { argumentCount: 1 });
    const resolve = (slug: string) =>
      kind === "metadata"
        ? resolveModuleMetadata({ generateMetadata: cached }, { slug })
        : resolveModuleViewport({ generateViewport: cached }, { slug });
    expect(await resolve("first")).toEqual(
      kind === "metadata" ? { title: "first" } : { themeColor: "first" },
    );
    expect(await resolve("second")).toEqual(
      kind === "metadata" ? { title: "second" } : { themeColor: "second" },
    );
    await resolve("first");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("marks layout probes before invoking the cached component", async () => {
    const observed: string[] = [];
    const Layout = registerCachedFunction(
      async ({ params }: { params?: unknown }) => {
        observed.push((params as ReturnType<typeof makeThenableParams<{ slug: string }>>).slug);
        return null;
      },
      "layout-probe",
      "",
      { argumentCount: 1 },
    );
    const probe = (slug: string) =>
      probeAppPageLayoutWithTracking({
        layoutIndex: 0,
        layoutParamAccess: undefined,
        makeThenableParams,
        matchedParams: { slug },
        route: {
          layoutTreePositions: [1],
          layouts: [{ default: Layout }],
          routeSegments: ["[slug]"],
        },
      });
    await probe("first");
    await probe("second");
    await probe("first");
    expect(observed).toEqual(["first", "second"]);
  });
});
