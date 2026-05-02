/**
 * Repro + regression tests for the silently-dropped `.cause` chain in
 * single-pass error formatters (Vite's dev-server "Internal server error:"
 * logger and similar).
 *
 * The bug: a wrapper like
 *   new Error("Failed query: ...", { cause: pgError })
 * would surface in the dev console as just "Failed query: ..." — the actual
 * postgres ECONNREFUSED / role-missing / socket error in `.cause` was lost
 * because Vite's `buildErrorMessage` only reads `.message` and `.stack`.
 *
 * The fix: vinext flattens the cause chain into `err.message` and `err.stack`
 * before the error escapes its handler boundary, so single-pass formatters
 * surface the root cause.
 */
import { describe, it, expect } from "vite-plus/test";
import { inspect } from "node:util";
import { flattenErrorCauses } from "../packages/vinext/src/utils/error-cause.js";

// Mirror Vite's `cleanStack` from
// vite-plus-core/dist/vite/node/chunks/node.js (~line 7730) — keeps only
// `at`-prefixed frames. Used here to verify cause stack frames survive that
// filter when emitted into err.stack.
function cleanStack(stack: string): string {
  return stack
    .split("\n")
    .filter((l) => /^\s*at/.test(l))
    .join("\n");
}

// Mirror Vite's `buildErrorMessage` shape — what the dev-server actually
// prints. If a cause is present and we don't flatten, the cause is invisible
// in the rendered output.
function buildViteLikeMessage(err: Error): string {
  return `Internal server error: ${err.message}\n${cleanStack(err.stack ?? "")}`;
}

describe("flattenErrorCauses", () => {
  it("repro: without flattening, Vite-style formatter drops the cause", () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:5432");
    const wrapped = new Error("Failed query: select ...", { cause });

    const rendered = buildViteLikeMessage(wrapped);

    expect(rendered).toContain("Failed query: select ...");
    // This is the bug the user reported:
    expect(rendered).not.toContain("ECONNREFUSED");
  });

  it("after flattening, the cause message appears in the rendered output", () => {
    const cause = new Error("ECONNREFUSED 127.0.0.1:5432");
    const wrapped = new Error("Failed query: select ...", { cause });

    flattenErrorCauses(wrapped);
    const rendered = buildViteLikeMessage(wrapped);

    expect(rendered).toContain("Failed query: select ...");
    expect(rendered).toContain("ECONNREFUSED 127.0.0.1:5432");
    expect(rendered).toContain("[cause]");
  });

  it("walks a multi-level cause chain", () => {
    const root = new Error('role "vinext" does not exist');
    const mid = new Error("connection failed", { cause: root });
    const top = new Error("Failed query", { cause: mid });

    flattenErrorCauses(top);

    expect(top.message).toContain("Failed query");
    expect(top.message).toContain("connection failed");
    expect(top.message).toContain('role "vinext" does not exist');
  });

  it("preserves cause stack frames as `at` lines so cleanStack keeps them", () => {
    const cause = new Error("inner");
    const wrapped = new Error("outer", { cause });

    flattenErrorCauses(wrapped);

    // The marker line itself must start with "    at " so Vite's cleanStack
    // (which filters to /^\s*at/) doesn't strip it.
    const cleaned = cleanStack(wrapped.stack ?? "");
    expect(cleaned).toMatch(/^\s*at \[cause: inner\]/m);
  });

  it("is idempotent — calling twice does not double-append", () => {
    const cause = new Error("inner");
    const wrapped = new Error("outer", { cause });

    flattenErrorCauses(wrapped);
    const messageAfterFirst = wrapped.message;
    const stackAfterFirst = wrapped.stack;

    flattenErrorCauses(wrapped);
    expect(wrapped.message).toBe(messageAfterFirst);
    expect(wrapped.stack).toBe(stackAfterFirst);
  });

  it("is a no-op when there is no cause", () => {
    const err = new Error("plain");
    const originalMessage = err.message;
    const originalStack = err.stack;

    flattenErrorCauses(err);

    expect(err.message).toBe(originalMessage);
    expect(err.stack).toBe(originalStack);
  });

  it("handles non-Error causes (string, plain object)", () => {
    const stringCause = new Error("wrap1", { cause: "raw string reason" });
    flattenErrorCauses(stringCause);
    expect(stringCause.message).toContain("raw string reason");

    const objectCause = new Error("wrap2", { cause: { code: "ECONNRESET" } });
    flattenErrorCauses(objectCause);
    expect(objectCause.message).toContain("ECONNRESET");
  });

  it("handles cyclic cause graphs without looping forever", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;

    flattenErrorCauses(a);

    expect(a.message).toContain("a");
    expect(a.message).toContain("b");
  });

  it("ignores non-Error inputs gracefully", () => {
    expect(() => flattenErrorCauses(undefined)).not.toThrow();
    expect(() => flattenErrorCauses(null)).not.toThrow();
    expect(() => flattenErrorCauses("oops")).not.toThrow();
    expect(() => flattenErrorCauses({ message: "fake" })).not.toThrow();
  });

  it("the flatten marker is invisible to util.inspect (no symbol leak in error output)", () => {
    const err = new Error("outer", { cause: new Error("inner") });
    flattenErrorCauses(err);

    // util.inspect is what console.error uses to render Errors. The marker
    // must not appear in its output — otherwise prod logs (which call this
    // function via the gated dev-only branch is fine, but local repros and
    // tests still inspect flattened errors) would gain a stray
    // "[Symbol(vinext.errorCausesFlattened)]: true" line.
    const rendered = inspect(err, { showHidden: false });
    expect(rendered).not.toContain("vinext.errorCausesFlattened");
    expect(rendered).not.toContain("Symbol(");
  });

  it("never throws on a frozen Error — leaves it unmodified rather than masking the original failure", () => {
    // If user code throws Object.freeze(new Error(...)), defineProperty and
    // err.message = ... would each throw TypeError. The catch block in the
    // generated handler would then propagate that TypeError instead of the
    // user's real error, masking the actual failure during debugging. The
    // helper's contract is best-effort: never throw.
    const cause = new Error("inner");
    const wrapped = new Error("outer", { cause });
    Object.freeze(wrapped);

    expect(() => flattenErrorCauses(wrapped)).not.toThrow();
    expect(wrapped.message).toBe("outer");
  });
});
