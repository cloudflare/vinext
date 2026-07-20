/**
 * Deploy-mode tests for `next/after` (`unstable_after`).
 *
 * Verify that the per-request Cloudflare Workers `ExecutionContext` is wired
 * through to the `after()` shim so callbacks are kept alive past the response
 * via `ctx.waitUntil()`.
 *
 * Ported behavior tests from:
 * https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/next-after-app-deploy/index.test.ts
 *
 * Issue: https://github.com/cloudflare/vinext/issues/1365
 */
import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { readPagesRouterEntrySource } from "./worker-entry-source.js";

type ExecutionContextLike = {
  waitUntil(promise: Promise<unknown>): void;
};

function createMockCtx(): ExecutionContextLike & { promises: Promise<unknown>[] } {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise: Promise<unknown>) {
      promises.push(promise);
    },
  };
}

describe("after() in deploy mode — ctx.waitUntil wiring", () => {
  it("after() forwards its task to ctx.waitUntil when an ExecutionContext is in scope", async () => {
    const { after } = await import("../packages/vinext/src/shims/server.js");
    const { runWithExecutionContext } =
      await import("../packages/vinext/src/shims/request-context.js");

    const ctx = createMockCtx();
    let observedSideEffect = false;

    await runWithExecutionContext(ctx, () => {
      after(async () => {
        // Simulate a real after() workload (e.g. revalidate, analytics) that
        // resolves after the response would have been sent.
        await Promise.resolve();
        observedSideEffect = true;
      });
    });

    // ctx.waitUntil must be called synchronously inside after() so the
    // Workers runtime knows to keep the isolate alive.
    expect(ctx.promises).toHaveLength(1);

    // Awaiting the queued promise mirrors what the Workers runtime does
    // after the response is sent. The callback must complete.
    await ctx.promises[0];
    expect(observedSideEffect).toBe(true);
  });

  it("after() preserves ctx across async hops simulating the App Router request lifecycle", async () => {
    const { after } = await import("../packages/vinext/src/shims/server.js");
    const { runWithExecutionContext, getRequestExecutionContext } =
      await import("../packages/vinext/src/shims/request-context.js");

    const ctx = createMockCtx();
    let observedCtxInsideCallback: unknown = "not-run";

    await runWithExecutionContext(ctx, async () => {
      // Simulate the chain of async work that happens between worker entry
      // and a user component / route handler calling after().
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      // The ALS must still surface ctx here — this is what after() relies on.
      expect(getRequestExecutionContext()).toBe(ctx);
      after(() => {
        observedCtxInsideCallback = "ran";
      });
    });

    expect(ctx.promises).toHaveLength(1);
    await ctx.promises[0];
    expect(observedCtxInsideCallback).toBe("ran");
  });

  it("after() inside a unified request scope still calls ctx.waitUntil", async () => {
    // The unified request context replaces the standalone executionContext ALS
    // for the duration of an App Router request. Verify after() still reads
    // the ctx via the unified scope so server components / route handlers
    // can schedule deferred work.
    const { after } = await import("../packages/vinext/src/shims/server.js");
    const { closeAfterResponse, createRequestContext, runWithRequestContext } =
      await import("../packages/vinext/src/shims/unified-request-context.js");

    const ctx = createMockCtx();
    const requestContext = createRequestContext({ executionContext: ctx });
    let ran = false;

    await runWithRequestContext(requestContext, async () => {
      after(async () => {
        await Promise.resolve();
        ran = true;
      });
    });

    expect(ctx.promises).toHaveLength(1);
    expect(ran).toBe(false);
    await closeAfterResponse(requestContext);
    await ctx.promises[0];
    expect(ran).toBe(true);
  });

  it("App Router worker entry wraps the RSC handler with runWithExecutionContext when ctx is provided", async () => {
    // Verify the default vinext/server/app-router-entry hooks ctx.waitUntil
    // before calling the RSC handler so after() callbacks survive the response.
    // We can't import the module directly (it pulls in a virtual RSC entry
    // that's resolved at build time), so we assert its source structure
    // alongside the runtime behavior of runWithExecutionContext.
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const src = await readFile(
      resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts"),
      "utf8",
    );

    expect(src).toContain("runWithExecutionContext(ctx, handleFn) : handleFn()");

    // Sanity-check the underlying primitive: with a ctx in scope,
    // getRequestExecutionContext() must surface it for after().
    const { runWithExecutionContext, getRequestExecutionContext } =
      await import("../packages/vinext/src/shims/request-context.js");
    const ctx = createMockCtx();
    let observedCtx: unknown = "missing";
    void runWithExecutionContext(ctx, () => {
      observedCtx = getRequestExecutionContext();
    });
    expect(observedCtx).toBe(ctx);
  });
});

describe("after() in deploy mode — Pages Router worker entry", () => {
  it("forwards ctx to handleApiRoute so api routes can call after()", () => {
    // Regression for #1365: handleApiRoute previously ignored ctx, leaving
    // after() inside Pages Router api routes without a way to call
    // ctx.waitUntil(). The generated worker entry must thread ctx through.
    //
    // After #1336 item 3 the dispatch URL is `apiLookupUrl` (the locale-
    // stripped form of `resolvedUrl`), but `ctx` is still threaded through.
    const content = readPagesRouterEntrySource();
    expect(content).toContain("handleApiRoute(req, apiUrl, ctx)");
  });

  it("forwards ctx and staged middleware headers to renderPage so page renders can call after() and apply CSP nonces", () => {
    const content = readPagesRouterEntrySource();
    expect(content).toContain("renderPage(req, resolvedUrl, null, ctx, stagedHeaders, options)");
  });
});

describe("after() in deploy mode — App Router worker entry", () => {
  it("delegates to handler.fetch with ctx so vinext/server/app-router-entry can wrap with runWithExecutionContext", () => {
    const content = fs.readFileSync(
      path.resolve(import.meta.dirname, "../packages/vinext/src/server/app-router-entry.ts"),
      "utf-8",
    );
    expect(content).toContain("runWithExecutionContext(ctx");
  });
});

describe("after() in deploy mode — Pages Router API handler", () => {
  it("handlePagesApiRoute wraps the user handler in runWithExecutionContext when ctx is provided", async () => {
    const { handlePagesApiRoute } =
      await import("../packages/vinext/src/server/pages-api-route.js");
    const { getRequestExecutionContext } =
      await import("../packages/vinext/src/shims/request-context.js");

    const ctx = createMockCtx();
    let observedCtx: unknown = "missing";

    const route = {
      pattern: "/api/test",
      module: {
        async default(_req: unknown, res: { end: (body?: string) => void; statusCode: number }) {
          observedCtx = getRequestExecutionContext();
          res.statusCode = 200;
          res.end("ok");
        },
      },
    };

    await handlePagesApiRoute({
      match: { params: {}, route },
      request: new Request("https://example.test/api/test"),
      url: "/api/test",
      ctx,
    });

    expect(observedCtx).toBe(ctx);
  });

  it("handlePagesApiRoute works without ctx (Node dev parity)", async () => {
    const { handlePagesApiRoute } =
      await import("../packages/vinext/src/server/pages-api-route.js");

    let ran = false;
    const route = {
      pattern: "/api/test",
      module: {
        default(_req: unknown, res: { end: (body?: string) => void; statusCode: number }) {
          ran = true;
          res.statusCode = 200;
          res.end("ok");
        },
      },
    };

    const response = await handlePagesApiRoute({
      match: { params: {}, route },
      request: new Request("https://example.test/api/test"),
      url: "/api/test",
    });

    expect(ran).toBe(true);
    expect(response.status).toBe(200);
  });
});
