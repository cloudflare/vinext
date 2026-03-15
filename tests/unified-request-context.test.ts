import { describe, it, expect } from "vite-plus/test";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  isInsideUnifiedScope,
} from "../packages/vinext/src/shims/unified-request-context.js";
import {
  getRequestExecutionContext,
  runWithExecutionContext,
} from "../packages/vinext/src/shims/request-context.js";

describe("unified-request-context", () => {
  describe("isInsideUnifiedScope", () => {
    it("returns false outside any scope", () => {
      expect(isInsideUnifiedScope()).toBe(false);
    });

    it("returns true inside a runWithRequestContext scope", () => {
      const ctx = createRequestContext();
      runWithRequestContext(ctx, () => {
        expect(isInsideUnifiedScope()).toBe(true);
      });
    });
  });

  describe("getRequestContext", () => {
    it("returns default values outside any scope", () => {
      const ctx = getRequestContext();
      expect(ctx).toBeDefined();
      expect(ctx.headersContext).toBeNull();
      expect(ctx.dynamicUsageDetected).toBe(false);
      expect(ctx.pendingSetCookies).toEqual([]);
      expect(ctx.draftModeCookieHeader).toBeNull();
      expect(ctx.phase).toBe("render");
      expect(ctx.i18nContext).toBeNull();
      expect(ctx.serverContext).toBeNull();
      expect(ctx.serverInsertedHTMLCallbacks).toEqual([]);
      expect(ctx.requestScopedCacheLife).toBeNull();
      expect(ctx._privateCache).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
      expect(ctx.executionContext).toBeNull();
      expect(ctx.ssrContext).toBeNull();
      expect(ctx.ssrHeadChildren).toEqual([]);
    });

    it("returns a fresh detached context on each call outside any scope", () => {
      const first = getRequestContext();
      first.dynamicUsageDetected = true;
      first.pendingSetCookies.push("first=1");

      const second = getRequestContext();
      expect(second).not.toBe(first);
      expect(second.dynamicUsageDetected).toBe(false);
      expect(second.pendingSetCookies).toEqual([]);
    });

    it("inherits the standalone ExecutionContext ALS in detached fallback mode", () => {
      const outerCtx = {
        waitUntil() {},
      };

      runWithExecutionContext(outerCtx, () => {
        expect(isInsideUnifiedScope()).toBe(false);
        expect(getRequestContext().executionContext).toBe(outerCtx);
      });
    });
  });

  describe("runWithRequestContext", () => {
    it("makes all fields accessible inside the scope", () => {
      const headers = new Headers({ "x-test": "1" });
      const cookies = new Map([["session", "abc"]]);
      const fakeCtx = { waitUntil: () => {} };

      const reqCtx = createRequestContext({
        headersContext: { headers, cookies },
        executionContext: fakeCtx,
      });

      runWithRequestContext(reqCtx, () => {
        const ctx = getRequestContext();
        expect((ctx.headersContext as any).headers.get("x-test")).toBe("1");
        expect((ctx.headersContext as any).cookies.get("session")).toBe("abc");
        expect(ctx.executionContext).toBe(fakeCtx);
        expect(ctx.dynamicUsageDetected).toBe(false);
        expect(ctx.phase).toBe("render");
        expect(ctx.i18nContext).toBeNull();
        expect(ctx.pendingSetCookies).toEqual([]);
        expect(ctx.currentRequestTags).toEqual([]);
        expect(ctx._privateCache).toBeNull();
      });
    });

    it("returns the value from fn (sync)", () => {
      const ctx = createRequestContext();
      const result = runWithRequestContext(ctx, () => 42);
      expect(result).toBe(42);
    });

    it("returns the value from fn (async)", async () => {
      const ctx = createRequestContext();
      const result = await runWithRequestContext(ctx, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return 99;
      });
      expect(result).toBe(99);
    });

    it("scope is exited after fn completes", async () => {
      const ctx = createRequestContext({
        headersContext: { headers: new Headers(), cookies: new Map() },
      });

      await runWithRequestContext(ctx, async () => {
        expect(isInsideUnifiedScope()).toBe(true);
      });

      expect(isInsideUnifiedScope()).toBe(false);
    });
  });

  describe("concurrent isolation", () => {
    it("20 parallel requests each see their own headers/navigation/tags", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => {
          const reqCtx = createRequestContext({
            headersContext: {
              headers: new Headers({ "x-id": String(i) }),
              cookies: new Map(),
            },
            currentRequestTags: [`tag-${i}`],
            serverContext: {
              pathname: `/path-${i}`,
              searchParams: new URLSearchParams(),
              params: {},
            },
          });
          return runWithRequestContext(reqCtx, async () => {
            const delayMs = (i % 10) + 1;
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            const ctx = getRequestContext();
            return {
              headerId: (ctx.headersContext as any)?.headers?.get("x-id"),
              tag: ctx.currentRequestTags[0],
              pathname: (ctx.serverContext as any)?.pathname,
            };
          });
        }),
      );

      for (let i = 0; i < 20; i++) {
        expect(results[i].headerId).toBe(String(i));
        expect(results[i].tag).toBe(`tag-${i}`);
        expect(results[i].pathname).toBe(`/path-${i}`);
      }
    });

    it("mutations in one scope don't leak to another", async () => {
      const ctxA = createRequestContext();
      const ctxB = createRequestContext();

      const pA = runWithRequestContext(ctxA, async () => {
        getRequestContext().dynamicUsageDetected = true;
        getRequestContext().pendingSetCookies.push("a=1");
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return {
          dynamic: getRequestContext().dynamicUsageDetected,
          cookies: [...getRequestContext().pendingSetCookies],
        };
      });

      const pB = runWithRequestContext(ctxB, async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        return {
          dynamic: getRequestContext().dynamicUsageDetected,
          cookies: [...getRequestContext().pendingSetCookies],
        };
      });

      const [a, b] = await Promise.all([pA, pB]);
      expect(a.dynamic).toBe(true);
      expect(a.cookies).toEqual(["a=1"]);
      expect(b.dynamic).toBe(false);
      expect(b.cookies).toEqual([]);
    });
  });

  describe("privateCache lazy initialization", () => {
    it("is null by default", () => {
      const ctx = createRequestContext();
      expect(ctx._privateCache).toBeNull();
    });

    it("stays null until explicitly set", () => {
      const ctx = createRequestContext();
      runWithRequestContext(ctx, () => {
        expect(getRequestContext()._privateCache).toBeNull();
      });
    });
  });

  describe("nested scopes", () => {
    it("inner runWithRequestContext overrides outer, restores on exit", () => {
      const outerCtx = createRequestContext({
        headersContext: {
          headers: new Headers({ "x-id": "outer" }),
          cookies: new Map(),
        },
      });
      const innerCtx = createRequestContext({
        headersContext: {
          headers: new Headers({ "x-id": "inner" }),
          cookies: new Map(),
        },
      });

      runWithRequestContext(outerCtx, () => {
        expect((getRequestContext().headersContext as any).headers.get("x-id")).toBe("outer");

        runWithRequestContext(innerCtx, () => {
          expect((getRequestContext().headersContext as any).headers.get("x-id")).toBe("inner");
        });

        // Outer scope restored
        expect((getRequestContext().headersContext as any).headers.get("x-id")).toBe("outer");
      });
    });
  });

  describe("executionContext", () => {
    it("is null by default", () => {
      const ctx = createRequestContext();
      runWithRequestContext(ctx, () => {
        expect(getRequestContext().executionContext).toBeNull();
      });
    });

    it("is accessible when provided", () => {
      const calls: Promise<unknown>[] = [];
      const fakeCtx = {
        waitUntil(p: Promise<unknown>) {
          calls.push(p);
        },
      };
      const ctx = createRequestContext({ executionContext: fakeCtx });
      runWithRequestContext(ctx, () => {
        const ec = getRequestContext().executionContext as any;
        expect(ec).toBe(fakeCtx);
        ec.waitUntil(Promise.resolve("done"));
      });
      expect(calls).toHaveLength(1);
    });

    it("inherits the outer ExecutionContext ALS when none is provided", () => {
      const outerCtx = {
        waitUntil() {},
      };

      runWithExecutionContext(outerCtx, () => {
        runWithRequestContext(createRequestContext(), () => {
          expect(getRequestContext().executionContext).toBe(outerCtx);
          expect(getRequestExecutionContext()).toBe(outerCtx);
        });
      });
    });
  });

  describe("sub-state field access", () => {
    it("each sub-state getter returns correct sub-fields", () => {
      const reqCtx = createRequestContext({
        headersContext: { headers: new Headers(), cookies: new Map() },
        dynamicUsageDetected: true,
        pendingSetCookies: ["a=b"],
        draftModeCookieHeader: "c=d",
        phase: "action",
        i18nContext: { locale: "fr", defaultLocale: "en" },
        serverContext: { pathname: "/test", searchParams: new URLSearchParams(), params: {} },
        serverInsertedHTMLCallbacks: [() => "html"],
        requestScopedCacheLife: { stale: 10, revalidate: 20 },
        currentRequestTags: ["tag1"],
        executionContext: { waitUntil: () => {} },
      });

      runWithRequestContext(reqCtx, () => {
        const ctx = getRequestContext();
        expect(ctx.dynamicUsageDetected).toBe(true);
        expect(ctx.pendingSetCookies).toEqual(["a=b"]);
        expect(ctx.draftModeCookieHeader).toBe("c=d");
        expect(ctx.phase).toBe("action");
        expect(ctx.i18nContext).toEqual({ locale: "fr", defaultLocale: "en" });
        expect((ctx.serverContext as any).pathname).toBe("/test");
        expect(ctx.serverInsertedHTMLCallbacks).toHaveLength(1);
        expect(ctx.requestScopedCacheLife).toEqual({
          stale: 10,
          revalidate: 20,
        });
        expect(ctx.currentRequestTags).toEqual(["tag1"]);
        expect(ctx.executionContext).not.toBeNull();
        expect(ctx.ssrContext).toBeNull();
        expect(ctx.ssrHeadChildren).toEqual([]);
      });
    });
  });

  describe("legacy wrapper semantics inside unified scope", () => {
    it("runWithHeadersContext restores the outer headers sub-state", async () => {
      const { runWithHeadersContext } = await import("../packages/vinext/src/shims/headers.js");

      const outerHeaders = {
        headers: new Headers({ "x-id": "outer" }),
        cookies: new Map([["outer", "1"]]),
      };
      const innerHeaders = {
        headers: new Headers({ "x-id": "inner" }),
        cookies: new Map([["inner", "1"]]),
      };

      runWithRequestContext(
        createRequestContext({
          headersContext: outerHeaders,
          dynamicUsageDetected: true,
          pendingSetCookies: ["outer=1"],
          draftModeCookieHeader: "outer=draft",
          phase: "action",
        }),
        () => {
          runWithHeadersContext(innerHeaders as any, () => {
            const ctx = getRequestContext();
            expect((ctx.headersContext as any).headers.get("x-id")).toBe("inner");
            expect(ctx.dynamicUsageDetected).toBe(false);
            expect(ctx.pendingSetCookies).toEqual([]);
            expect(ctx.draftModeCookieHeader).toBeNull();
            expect(ctx.phase).toBe("render");

            ctx.dynamicUsageDetected = true;
            ctx.pendingSetCookies.push("inner=1");
            ctx.draftModeCookieHeader = "inner=draft";
            ctx.phase = "route-handler";
          });

          const ctx = getRequestContext();
          expect(ctx.headersContext).toBe(outerHeaders);
          expect(ctx.dynamicUsageDetected).toBe(true);
          expect(ctx.pendingSetCookies).toEqual(["outer=1"]);
          expect(ctx.draftModeCookieHeader).toBe("outer=draft");
          expect(ctx.phase).toBe("action");
        },
      );
    });

    it("runWithHeadersContext keeps spawned async work on the inner sub-state", async () => {
      const { runWithHeadersContext } = await import("../packages/vinext/src/shims/headers.js");

      let releaseInnerRead!: () => void;
      const waitForInnerRead = new Promise<void>((resolve) => {
        releaseInnerRead = resolve;
      });
      let innerRead!: Promise<string | null>;

      await runWithRequestContext(
        createRequestContext({
          headersContext: {
            headers: new Headers({ "x-id": "outer" }),
            cookies: new Map(),
          },
        }),
        async () => {
          runWithHeadersContext(
            {
              headers: new Headers({ "x-id": "inner" }),
              cookies: new Map(),
            },
            () => {
              innerRead = (async () => {
                await waitForInnerRead;
                return (getRequestContext().headersContext as any)?.headers?.get("x-id") ?? null;
              })();
            },
          );

          expect((getRequestContext().headersContext as any)?.headers?.get("x-id")).toBe("outer");
          releaseInnerRead();
          await expect(innerRead).resolves.toBe("inner");
        },
      );
    });

    it("runWithNavigationContext restores the outer navigation sub-state", async () => {
      const { runWithNavigationContext } =
        await import("../packages/vinext/src/shims/navigation-state.js");
      const { setNavigationContext, getNavigationContext } =
        await import("../packages/vinext/src/shims/navigation.js");

      const outerCallback = () => "outer";

      runWithRequestContext(
        createRequestContext({
          serverContext: { pathname: "/outer", searchParams: new URLSearchParams(), params: {} },
          serverInsertedHTMLCallbacks: [outerCallback],
        }),
        () => {
          runWithNavigationContext(() => {
            expect(getNavigationContext()).toBeNull();
            expect(getRequestContext().serverInsertedHTMLCallbacks).toEqual([]);

            setNavigationContext({
              pathname: "/inner",
              searchParams: new URLSearchParams("q=1"),
              params: { id: "1" },
            });
            getRequestContext().serverInsertedHTMLCallbacks.push(() => "inner");
          });

          expect((getNavigationContext() as any)?.pathname).toBe("/outer");
          expect(getRequestContext().serverInsertedHTMLCallbacks).toEqual([outerCallback]);
        },
      );
    });

    it("runWithI18nState restores the outer i18n sub-state", async () => {
      const { runWithI18nState } = await import("../packages/vinext/src/shims/i18n-state.js");
      const { getI18nContext, setI18nContext } =
        await import("../packages/vinext/src/shims/i18n-context.js");

      const outerI18n = {
        locale: "fr",
        locales: ["en", "fr"],
        defaultLocale: "en",
      };

      runWithRequestContext(
        createRequestContext({
          i18nContext: outerI18n,
        }),
        () => {
          runWithI18nState(() => {
            expect(getI18nContext()).toBeNull();

            setI18nContext({
              locale: "de",
              locales: ["en", "de"],
              defaultLocale: "en",
            });

            expect(getRequestContext().i18nContext).toEqual({
              locale: "de",
              locales: ["en", "de"],
              defaultLocale: "en",
            });
          });

          expect(getI18nContext()).toEqual(outerI18n);
          expect(getRequestContext().i18nContext).toEqual(outerI18n);
        },
      );
    });

    it("cache/private/fetch/router/head sub-scopes reset and restore correctly", async () => {
      const { _runWithCacheState } = await import("../packages/vinext/src/shims/cache.js");
      const { runWithPrivateCache } = await import("../packages/vinext/src/shims/cache-runtime.js");
      const { runWithFetchCache, getCollectedFetchTags } =
        await import("../packages/vinext/src/shims/fetch-cache.js");
      const { runWithRouterState } = await import("../packages/vinext/src/shims/router-state.js");
      const { setSSRContext } = await import("../packages/vinext/src/shims/router.js");
      const { runWithHeadState } = await import("../packages/vinext/src/shims/head-state.js");

      runWithRequestContext(
        createRequestContext({
          requestScopedCacheLife: { revalidate: 60 },
          _privateCache: new Map([["outer", 1]]),
          currentRequestTags: ["outer-tag"],
          ssrContext: { pathname: "/outer", query: {}, asPath: "/outer" },
          ssrHeadChildren: ["<meta data-outer />"],
        }),
        async () => {
          _runWithCacheState(() => {
            expect(getRequestContext().requestScopedCacheLife).toBeNull();
            getRequestContext().requestScopedCacheLife = { revalidate: 1 } as any;
          });
          expect(getRequestContext().requestScopedCacheLife).toEqual({ revalidate: 60 });

          runWithPrivateCache(() => {
            expect(getRequestContext()._privateCache).toBeInstanceOf(Map);
            expect(getRequestContext()._privateCache?.size).toBe(0);
            getRequestContext()._privateCache?.set("inner", 2);
          });
          expect([...getRequestContext()._privateCache!.entries()]).toEqual([["outer", 1]]);

          await runWithFetchCache(async () => {
            expect(getCollectedFetchTags()).toEqual([]);
            getRequestContext().currentRequestTags.push("inner-tag");
          });
          expect(getCollectedFetchTags()).toEqual(["outer-tag"]);

          runWithRouterState(() => {
            expect(getRequestContext().ssrContext).toBeNull();
            setSSRContext({ pathname: "/inner", query: {}, asPath: "/inner" } as any);
          });
          expect((getRequestContext().ssrContext as any).pathname).toBe("/outer");

          runWithHeadState(() => {
            expect(getRequestContext().ssrHeadChildren).toEqual([]);
            getRequestContext().ssrHeadChildren.push("<meta data-inner />");
          });
          expect(getRequestContext().ssrHeadChildren).toEqual(["<meta data-outer />"]);
        },
      );
    });
  });

  describe("createRequestContext", () => {
    it("creates context with all defaults", () => {
      const ctx = createRequestContext();
      expect(ctx.headersContext).toBeNull();
      expect(ctx.dynamicUsageDetected).toBe(false);
      expect(ctx.pendingSetCookies).toEqual([]);
      expect(ctx.draftModeCookieHeader).toBeNull();
      expect(ctx.phase).toBe("render");
      expect(ctx.i18nContext).toBeNull();
      expect(ctx.serverContext).toBeNull();
      expect(ctx.serverInsertedHTMLCallbacks).toEqual([]);
      expect(ctx.requestScopedCacheLife).toBeNull();
      expect(ctx._privateCache).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
      expect(ctx.executionContext).toBeNull();
      expect(ctx.ssrContext).toBeNull();
      expect(ctx.ssrHeadChildren).toEqual([]);
    });

    it("merges partial overrides", () => {
      const ctx = createRequestContext({
        phase: "action",
        dynamicUsageDetected: true,
      });
      expect(ctx.phase).toBe("action");
      expect(ctx.dynamicUsageDetected).toBe(true);
      // Other fields get defaults
      expect(ctx.i18nContext).toBeNull();
      expect(ctx.headersContext).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
      expect(ctx.ssrContext).toBeNull();
      expect(ctx.ssrHeadChildren).toEqual([]);
    });
  });
});
