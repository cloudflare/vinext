import { describe, it, expect } from "vitest";
import {
  runWithExecutionContext,
  getRequestExecutionContext,
  type ExecutionContextLike,
} from "../packages/vinext/src/shims/request-context.js";

function makeCtx(): ExecutionContextLike & { calls: Promise<unknown>[] } {
  const calls: Promise<unknown>[] = [];
  return {
    calls,
    waitUntil(p: Promise<unknown>) {
      calls.push(p);
    },
  };
}

describe("getRequestExecutionContext", () => {
  it("returns null outside a runWithExecutionContext scope", () => {
    // Ensure we're not accidentally inside a scope from a previous test
    expect(getRequestExecutionContext()).toBeNull();
  });
});

describe("runWithExecutionContext", () => {
  it("makes the context available inside the scope", () => {
    const ctx = makeCtx();
    runWithExecutionContext(ctx, () => {
      expect(getRequestExecutionContext()).toBe(ctx);
    });
  });

  it("returns null outside the scope after it exits", async () => {
    const ctx = makeCtx();
    await runWithExecutionContext(ctx, async () => {
      expect(getRequestExecutionContext()).toBe(ctx);
    });
    expect(getRequestExecutionContext()).toBeNull();
  });

  it("propagates through async continuations (Promise chains)", async () => {
    const ctx = makeCtx();
    let captured: ExecutionContextLike | null = null;

    await runWithExecutionContext(ctx, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      captured = getRequestExecutionContext();
    });

    expect(captured).toBe(ctx);
  });

  it("isolates concurrent requests — each sees its own ctx", async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();

    const results: Array<{ id: string; ctx: ExecutionContextLike | null }> = [];

    const runA = runWithExecutionContext(ctxA, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      results.push({ id: "A", ctx: getRequestExecutionContext() });
    });

    const runB = runWithExecutionContext(ctxB, async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      results.push({ id: "B", ctx: getRequestExecutionContext() });
    });

    await Promise.all([runA, runB]);

    const a = results.find((r) => r.id === "A");
    const b = results.find((r) => r.id === "B");

    expect(a?.ctx).toBe(ctxA);
    expect(b?.ctx).toBe(ctxB);
  });

  it("returns the value from fn", async () => {
    const ctx = makeCtx();
    const result = await runWithExecutionContext(ctx, async () => 42);
    expect(result).toBe(42);
  });

  it("ctx.waitUntil can be called from inside the scope", async () => {
    const ctx = makeCtx();
    const p = Promise.resolve("done");

    runWithExecutionContext(ctx, () => {
      const c = getRequestExecutionContext();
      c?.waitUntil(p);
    });

    expect(ctx.calls).toContain(p);
  });

  it("nested runWithExecutionContext overrides the outer ctx", () => {
    const outerCtx = makeCtx();
    const innerCtx = makeCtx();

    runWithExecutionContext(outerCtx, () => {
      expect(getRequestExecutionContext()).toBe(outerCtx);

      runWithExecutionContext(innerCtx, () => {
        expect(getRequestExecutionContext()).toBe(innerCtx);
      });

      // Outer scope is restored after inner exits
      expect(getRequestExecutionContext()).toBe(outerCtx);
    });
  });
});
