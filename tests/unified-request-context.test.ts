import { describe, it, expect } from "vitest";
import {
  createRequestContext,
  runWithRequestContext,
  getRequestContext,
  isInsideUnifiedScope,
} from "../packages/vinext/src/shims/unified-request-context.js";

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
    it("returns fallback with default values outside any scope", () => {
      const ctx = getRequestContext();
      expect(ctx).toBeDefined();
      expect(ctx.headersContext).toBeNull();
      expect(ctx.dynamicUsageDetected).toBe(false);
      expect(ctx.pendingSetCookies).toEqual([]);
      expect(ctx.draftModeCookieHeader).toBeNull();
      expect(ctx.phase).toBe("render");
      expect(ctx.serverContext).toBeNull();
      expect(ctx.serverInsertedHTMLCallbacks).toEqual([]);
      expect(ctx.requestScopedCacheLife).toBeNull();
      expect(ctx._privateCache).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
      expect(ctx.executionContext).toBeNull();
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
            serverContext: { pathname: `/path-${i}` },
          });
          return runWithRequestContext(reqCtx, async () => {
            // Simulate async work with varying delays
            await new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 10));
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
  });

  describe("sub-state field access", () => {
    it("each sub-state getter returns correct sub-fields", () => {
      const reqCtx = createRequestContext({
        headersContext: { headers: new Headers(), cookies: new Map() },
        dynamicUsageDetected: true,
        pendingSetCookies: ["a=b"],
        draftModeCookieHeader: "c=d",
        phase: "action",
        serverContext: { pathname: "/test" },
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
        expect((ctx.serverContext as any).pathname).toBe("/test");
        expect(ctx.serverInsertedHTMLCallbacks).toHaveLength(1);
        expect(ctx.requestScopedCacheLife).toEqual({
          stale: 10,
          revalidate: 20,
        });
        expect(ctx.currentRequestTags).toEqual(["tag1"]);
        expect(ctx.executionContext).not.toBeNull();
      });
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
      expect(ctx.serverContext).toBeNull();
      expect(ctx.serverInsertedHTMLCallbacks).toEqual([]);
      expect(ctx.requestScopedCacheLife).toBeNull();
      expect(ctx._privateCache).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
      expect(ctx.executionContext).toBeNull();
    });

    it("merges partial overrides", () => {
      const ctx = createRequestContext({
        phase: "action",
        dynamicUsageDetected: true,
      });
      expect(ctx.phase).toBe("action");
      expect(ctx.dynamicUsageDetected).toBe(true);
      // Other fields get defaults
      expect(ctx.headersContext).toBeNull();
      expect(ctx.currentRequestTags).toEqual([]);
    });
  });
});
