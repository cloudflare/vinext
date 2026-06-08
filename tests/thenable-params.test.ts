import { describe, expect, it } from "vite-plus/test";
import {
  createPprFallbackShellState,
  preparePprFallbackShellFinalRender,
  runWithPprFallbackShellState,
} from "../packages/vinext/src/shims/ppr-fallback-shell.js";
import { makeThenableParams } from "../packages/vinext/src/shims/thenable-params.js";

describe("makeThenableParams", () => {
  it("is awaitable even when params contain then", async () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ then: "foo" });
    // If `then` were shadowing Promise.prototype.then, `await` would try to
    // treat the object as a thenable and call `then` with resolve/reject,
    // producing garbage or hanging. This must resolve to the plain object.
    const resolved = await params;
    // eslint-disable-next-line unicorn/no-thenable
    expect(resolved).toEqual({ then: "foo" });
  });

  it("allows sync access to non-well-known params", () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ slug: "post", then: "foo" });
    expect(params.slug).toBe("post");
  });

  it("protects Promise methods from shadowing so the object stays thenable", () => {
    // eslint-disable-next-line unicorn/no-thenable
    const params = makeThenableParams({ then: "foo", catch: "bar", finally: "baz" });

    expect(typeof params.then).toBe("function");
    expect(typeof params.catch).toBe("function");
    expect(typeof params.finally).toBe("function");
  });

  it("protects React Promise status from shadowing", () => {
    const params = makeThenableParams({ status: "ok" });

    // React uses `status` on Promises for introspection; it must not be
    // shadowed by a param of the same name. Use Reflect.get because the
    // type system omits well-known properties from the sync intersection.
    expect(Reflect.get(params, "status")).not.toBe("ok");
  });

  it("protects React Promise value and error from shadowing", () => {
    const params = makeThenableParams({ value: "foo", error: "bar" });

    // React may mutate resolved promises to attach `.value` and `.error`
    // for `use()` caching. Our Proxy must not return the param value for
    // these keys, or React would read the wrong value on re-render.
    expect(Reflect.get(params, "value")).not.toBe("foo");
    expect(Reflect.get(params, "error")).not.toBe("bar");
  });

  it("excludes well-known properties from enumeration", () => {
    /* eslint-disable unicorn/no-thenable */
    const params = makeThenableParams({
      slug: "post",
      then: "foo",
      catch: "bar",
      finally: "baz",
      status: "ok",
      value: "val",
      error: "err",
      toString: "str",
    });
    /* eslint-enable unicorn/no-thenable */

    const keys = Object.keys(params);
    expect(keys).toEqual(["slug"]);
  });

  it("makes well-known param values available after awaiting", async () => {
    /* eslint-disable unicorn/no-thenable */
    const params = makeThenableParams({
      slug: "post",
      then: "foo",
      catch: "bar",
      finally: "baz",
      status: "ok",
      value: "val",
      error: "err",
    });
    /* eslint-enable unicorn/no-thenable */

    const resolved = await params;
    expect(resolved.slug).toBe("post");
    expect(resolved.then).toBe("foo");
    expect(resolved.catch).toBe("bar");
    expect(resolved.finally).toBe("baz");
    expect(resolved.status).toBe("ok");
    expect(resolved.value).toBe("val");
    expect(resolved.error).toBe("err");
  });

  it("preserves catch-all array params through sync and awaited access", async () => {
    const params = makeThenableParams({ slug: ["a", "b"] });

    expect(Reflect.get(params, "slug")).toEqual(["a", "b"]);
    expect(Object.keys(params)).toEqual(["slug"]);
    expect(await params).toEqual({ slug: ["a", "b"] });
  });

  it("preserves empty params through sync keys and awaiting", async () => {
    const params = makeThenableParams({});

    expect(Object.keys(params)).toEqual([]);
    expect(await params).toEqual({});
  });

  it("reports direct param property access to an observer", () => {
    const observedKeys: string[][] = [];
    const params = makeThenableParams(
      { slug: "post" },
      {
        observeParamAccess(keys) {
          observedKeys.push([...keys]);
        },
      },
    );

    expect(params.slug).toBe("post");
    expect(observedKeys).toEqual([["slug"]]);
  });

  it("reports awaited params as an all-keys access", async () => {
    const observedKeys: string[][] = [];
    const params = makeThenableParams(
      { slug: "post", category: "news" },
      {
        observeParamAccess(keys) {
          observedKeys.push([...keys]);
        },
      },
    );

    await params;

    expect(observedKeys).toEqual([["slug", "category"]]);
  });

  it("reports destructured param property access to an observer", () => {
    const observedKeys: string[][] = [];
    const params = makeThenableParams(
      { slug: "post" },
      {
        observeParamAccess(keys) {
          observedKeys.push([...keys]);
        },
      },
    );

    const { slug } = params;

    expect(slug).toBe("post");
    expect(observedKeys).toEqual([["slug"]]);
  });

  it("suspends only fallback params during cacheComponents fallback-shell prerendering", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });
    let thrown: unknown;

    runWithPprFallbackShellState(state, () => {
      const params = makeThenableParams({ locale: "en", slug: "[slug]" });

      expect(params.locale).toBe("en");
      expect(Object.keys(params)).toEqual(["locale", "slug"]);
      try {
        Reflect.get(params, "slug");
      } catch (error) {
        thrown = error;
      }
    });
    state.abortController.abort();

    expect(thrown).toBeDefined();
    expect(typeof (thrown as Promise<unknown>).then).toBe("function");
  });

  it("awaited params object suspends on fallback param access", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    await runWithPprFallbackShellState(state, async () => {
      const params = makeThenableParams({ locale: "en", slug: "[slug]" });

      const result = await params;
      expect(result.locale).toBe("en");

      expect(() => Reflect.get(result, "slug")).toThrow();
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("awaiting params during fallback-shell prerender observes only accessed known params", async () => {
    const observedKeys: string[][] = [];
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    await runWithPprFallbackShellState(state, async () => {
      const params = makeThenableParams(
        { locale: "en", slug: "[slug]" },
        { observeParamAccess: (keys) => observedKeys.push([...keys]) },
      );

      const resolved = await params;
      expect(resolved.locale).toBe("en");
      // Known-param access must not convert the shell into a
      // dynamic-boundary shell — only actual fallback-param access does.
      expect(state.hasDynamicBoundary).toBe(false);
    });

    expect(observedKeys).toEqual([["locale"]]);
    state.abortController.abort();
  });

  it("does not mark dynamic boundary until a fallback param is actually accessed", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    runWithPprFallbackShellState(state, () => {
      const params = makeThenableParams({ locale: "en", slug: "[slug]" });
      expect(params.locale).toBe("en");
      expect(state.hasDynamicBoundary).toBe(false);

      try {
        Reflect.get(params, "slug");
      } catch {
        /* expected suspension */
      }
      expect(state.hasDynamicBoundary).toBe(true);
    });

    state.abortController.abort();
  });

  it("suspends on fallback param access even after the params object escapes the shell scope", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    // Build the params object inside the shell scope, then read the fallback
    // key after the scope has exited. The object must still suspend against the
    // shell that produced it instead of silently leaking the `[slug]`
    // placeholder.
    const params = runWithPprFallbackShellState(state, () =>
      makeThenableParams({ locale: "en", slug: "[slug]" }),
    );

    expect(params.locale).toBe("en");

    let thrownFromGet: unknown;
    try {
      Reflect.get(params, "slug");
    } catch (error) {
      thrownFromGet = error;
    }
    expect(thrownFromGet).toBeDefined();
    expect(typeof (thrownFromGet as Promise<unknown>).then).toBe("function");

    // The `getOwnPropertyDescriptor` trap must suspend identically — its getter
    // throws the same hanging promise instead of falling through to `undefined`
    // — so both traps agree on the out-of-scope path.
    const descriptor = Object.getOwnPropertyDescriptor(params, "slug");
    expect(typeof descriptor?.get).toBe("function");
    let thrownFromDescriptor: unknown;
    try {
      descriptor?.get?.();
    } catch (error) {
      thrownFromDescriptor = error;
    }
    expect(thrownFromDescriptor).toBeDefined();
    expect(typeof (thrownFromDescriptor as Promise<unknown>).then).toBe("function");

    state.abortController.abort();
  });

  it("re-derives fallback suspension against the live controller after a phase transition", async () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    const params = runWithPprFallbackShellState(state, () =>
      makeThenableParams({ locale: "en", slug: "[slug]" }),
    );

    // Warmup access throws a hanging promise wired to the warmup controller.
    let warmupPromise: Promise<unknown> | undefined;
    try {
      Reflect.get(params, "slug");
    } catch (error) {
      warmupPromise = error as Promise<unknown>;
    }
    expect(warmupPromise).toBeDefined();
    const warmupController = state.abortController;

    // Transition to the final render — this swaps in a fresh AbortController.
    preparePprFallbackShellFinalRender(state);
    expect(state.abortController).not.toBe(warmupController);

    // Final-phase access must throw a *new* hanging promise wired to the live
    // (final) controller, not the memoized warmup promise bound to the dead
    // signal the lifecycle will never abort again.
    let finalPromise: Promise<unknown> | undefined;
    try {
      Reflect.get(params, "slug");
    } catch (error) {
      finalPromise = error as Promise<unknown>;
    }
    expect(finalPromise).toBeDefined();
    expect(finalPromise).not.toBe(warmupPromise);

    // Aborting the live controller rejects the final-phase suspension.
    const rejectedAssertion = expect(finalPromise).rejects.toThrow();
    state.abortController.abort();
    await rejectedAssertion;

    // Settle the warmup promise too so it does not leak as unhandled.
    warmupController.abort();
    await (warmupPromise as Promise<unknown>).catch(() => {});
  });

  it("Object.keys(params) does not mark dynamic boundary before fallback param access", () => {
    const state = createPprFallbackShellState({
      fallbackParamNames: ["slug"],
      routePattern: "/:locale/blog/:slug",
    });

    runWithPprFallbackShellState(state, () => {
      const params = makeThenableParams({ locale: "en", slug: "[slug]" });
      Object.keys(params);
      expect(state.hasDynamicBoundary).toBe(false);
    });

    state.abortController.abort();
  });
});
